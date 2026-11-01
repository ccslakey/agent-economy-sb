import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type BotStrategy,
  type CompanyId,
  Contract,
  Observation,
  type Phase,
  RunState,
} from '@agent-economy/schema';
import { BOTS, type BotMemory, freshMemory } from './bots.ts';
import type { SessionResult, Spawner } from './claude.ts';
import { GameClient } from './mcp.ts';

// The runner. Drives one run over HTTP: LLM companies through headless sessions, bot companies
// through the same API. Pauses the run on quota, retries, and hands a company to the honest
// trader bot after repeated failures. Every session becomes a trace.

export type DriveOptions = {
  api: string;
  adminToken: string;
  runId: string;
  spawner: Spawner;
  systemPrompt: string;
  /** Where per-company MCP config files are written. */
  workDir: string;
  sleep: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  quotaWaitMs?: number;
  maxFailures?: number;
  farming?: boolean;
};

export type DriveResult = {
  turns: number;
  sessions: number;
  replaced: CompanyId[];
  /** The end-of-run report from the API: scores, plans, thoughts, notes, bug reports, farming answers. */
  report: unknown;
};

type Driver =
  | { kind: 'llm'; model: string; effort: string }
  | { kind: 'bot'; strategy: BotStrategy };

/**
 * The user message for a round. The first round of the game reads the docs and writes the plan.
 * The first round of later turns revises the plan. Later rounds act on what arrived.
 */
export const roundPrompt = (turn: number, round: number, budget: number): string => {
  const budgetLine = `You have ${budget} tool calls this round, including the ones already used, so plan your calls.`;
  if (turn === 1 && round === 1) {
    return `This is turn 1, round 1, the start of the game. Read rules.md, contracts.md, and api.md with the docs tool. Every action shape is in api.md; do not guess field names. Then read your observation; it shows your recipes and the reference prices. Write your game plan with write_plan: what you will do in the early game, the mid game, and the late game, what you are doing now, and your thoughts. Then submit your first batch of actions with submit_actions, and write notes for your future self: who you want to trade with, what you have offered, and what to check next round. ${budgetLine}`;
  }
  if (round === 1) {
    return `It is turn ${turn}, round 1 of 3. Read your plan, your notes, and your observation. Call write_plan this round: keep the early, mid, and late fields unless the game has changed, and rewrite now and thoughts to say what you are doing this turn and how you feel it is going. Then submit this turn's orders and proposals with submit_actions, and update your notes. ${budgetLine}`;
  }
  return `It is turn ${turn}, round ${round} of 3. Read your notes and your observation. Answer any proposals or messages that arrived, deliver and pay what you owe, and submit a batch with submit_actions, even an empty one. Update your notes if anything changed. ${budgetLine}`;
};

const FARMING_PROMPT =
  'The game has ended. Answer in prose, briefly: what wasted your time, what was confusing, what was missing, and which companies did you think were run by which model or bot, and why?';

export async function drive(options: DriveOptions): Promise<DriveResult> {
  const log = options.log ?? (() => undefined);
  const quotaWaitMs = options.quotaWaitMs ?? 5 * 60 * 1000;
  const maxFailures = options.maxFailures ?? 3;
  const admin = async <T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${options.api}${route}`, {
      method,
      headers: {
        'x-admin-token': options.adminToken,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
  const stateNow = async () =>
    RunState.parse(await admin('GET', `/admin/runs/${options.runId}/state`));
  const { tokens } = await admin<{ tokens: Record<string, string> }>(
    'GET',
    `/admin/runs/${options.runId}/tokens`,
  );

  const first = await stateNow();
  const drivers = new Map<CompanyId, Driver>();
  for (const entry of first.config.population) {
    drivers.set(
      entry.id,
      entry.driver.kind === 'llm'
        ? { kind: 'llm', model: entry.driver.model, effort: entry.driver.effort }
        : { kind: 'bot', strategy: entry.driver.strategy },
    );
  }
  const memories = new Map<CompanyId, BotMemory>();
  const failures = new Map<CompanyId, number>();
  const sessionIds = new Map<CompanyId, string>();
  const replaced: CompanyId[] = [];
  let sessions = 0;
  const acted = new Set<string>();
  const clients = new Map<CompanyId, GameClient>();
  for (const [company, token] of Object.entries(tokens)) {
    clients.set(company as CompanyId, new GameClient({ baseUrl: options.api, token }));
  }

  const mcpConfigPath = async (company: CompanyId): Promise<string> => {
    const file = path.join(options.workDir, `mcp-${company}.json`);
    const config = {
      mcpServers: {
        game: {
          command: 'node',
          args: [path.resolve(import.meta.dirname, 'mcp.ts')],
          env: { AGENT_ECONOMY_URL: options.api, AGENT_ECONOMY_TOKEN: tokens[company] ?? '' },
        },
      },
    };
    await writeFile(file, JSON.stringify(config));
    return file;
  };

  const recordTrace = async (
    company: CompanyId,
    turn: number,
    round: number | null,
    kind: 'round' | 'farming',
    model: string,
    result: SessionResult,
  ): Promise<void> => {
    sessions += 1;
    await admin('POST', `/admin/runs/${options.runId}/traces`, {
      company,
      turn,
      round,
      kind,
      session_id: result.ok ? result.sessionId : null,
      model,
      result: result.raw,
      tokens_in: result.ok ? result.tokensIn : 0,
      tokens_out: result.ok ? result.tokensOut : 0,
      cost_usd: result.ok ? result.costUsd : 0,
      duration_ms: result.durationMs,
    });
  };

  const handToBot = async (company: CompanyId, reason: string): Promise<void> => {
    log(`${company}: handing to the honest trader bot (${reason})`);
    await admin('POST', `/admin/runs/${options.runId}/replace`, {
      company,
      strategy: 'honest_trader',
      reason,
    });
    drivers.set(company, { kind: 'bot', strategy: 'honest_trader' });
    replaced.push(company);
  };

  /** One headless session, with quota pauses and retries. Returns once the company has acted or been replaced. */
  const runSession = async (
    company: CompanyId,
    driver: Extract<Driver, { kind: 'llm' }>,
    state: RunState,
    round: number,
  ): Promise<void> => {
    const resume =
      state.config.knobs.context_persistence === 'per_turn' && round > 1
        ? sessionIds.get(company)
        : undefined;
    const request = {
      prompt: roundPrompt(state.turn, round, state.config.limits.round_tool_calls),
      systemPrompt: options.systemPrompt,
      model: driver.model,
      effort: driver.effort,
      mcpConfigPath: await mcpConfigPath(company),
      cwd: options.workDir,
      ...(resume === undefined ? {} : { resume }),
    };
    for (;;) {
      const result = await options.spawner(request);
      if (result.ok) {
        if (result.sessionId !== null) sessionIds.set(company, result.sessionId);
        await recordTrace(company, state.turn, round, 'round', driver.model, result);
        return;
      }
      if (result.kind === 'quota') {
        log(`${company}: quota limit, pausing the run for ${quotaWaitMs}ms`);
        await admin('POST', `/admin/runs/${options.runId}/pause`, { reason: 'rate_limit' });
        await options.sleep(quotaWaitMs);
        await admin('POST', `/admin/runs/${options.runId}/resume`);
        continue;
      }
      await recordTrace(company, state.turn, round, 'round', driver.model, result);
      const count = (failures.get(company) ?? 0) + 1;
      failures.set(company, count);
      log(`${company}: session failed (${count}/${maxFailures}): ${result.message.slice(0, 200)}`);
      if (count >= maxFailures) {
        await handToBot(company, `session failed ${count} times: ${result.message.slice(0, 200)}`);
        return;
      }
    }
  };

  const runBot = async (
    company: CompanyId,
    strategy: BotStrategy,
    state: RunState,
    round: number,
  ) => {
    const client = clients.get(company);
    if (client === undefined) return;
    const observation = Observation.parse(JSON.parse(await client.call('GET', '/v1/observation')));
    const contracts = Contract.array().parse(
      (JSON.parse(await client.call('GET', '/v1/contracts')) as { contracts: unknown[] }).contracts,
    );
    const memory = memories.get(company) ?? freshMemory();
    memories.set(company, memory);
    const rng = (purpose: string) =>
      hashUnit(`${state.config.seed}|${state.turn}|${company}|${round}|${purpose}`);
    const actions = BOTS[strategy](
      { observation, contracts, prices: state.config.economy.reference_prices },
      memory,
      rng,
    );
    await client.call('POST', '/v1/actions', { actions });
  };

  const farm = async (state: RunState): Promise<void> => {
    for (const [company, driver] of drivers) {
      if (driver.kind !== 'llm') continue;
      const result = await options.spawner({
        prompt: FARMING_PROMPT,
        systemPrompt: options.systemPrompt,
        model: driver.model,
        effort: driver.effort,
        mcpConfigPath: await mcpConfigPath(company),
        cwd: options.workDir,
        ...(sessionIds.has(company) ? { resume: sessionIds.get(company) ?? '' } : {}),
      });
      await recordTrace(company, state.turn, null, 'farming', driver.model, result);
    }
  };

  for (;;) {
    const state = await stateNow();
    const phase: Phase = state.phase;
    if (phase.kind === 'ended') {
      if (options.farming !== false) await farm(state);
      const report = await admin<unknown>('GET', `/admin/runs/${options.runId}/report`);
      return { turns: state.turn, sessions, replaced, report };
    }
    if (phase.kind === 'paused') {
      await options.sleep(1000);
      continue;
    }
    if (phase.kind === 'operations') {
      await admin('POST', `/admin/runs/${options.runId}/advance`);
      continue;
    }
    const round = phase.round;
    const key = `${state.turn}:${round}`;
    const pending = Object.values(state.companies)
      .filter((c) => c.standing.kind === 'solvent' && !state.submitted.includes(c.id))
      .filter((c) => !acted.has(`${key}:${c.id}`))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (pending.length === 0) {
      const again = await stateNow();
      if (
        again.phase.kind === 'round' &&
        again.turn === state.turn &&
        again.phase.round === round
      ) {
        log(`turn ${state.turn} round ${round}: everyone acted, advancing`);
        await admin('POST', `/admin/runs/${options.runId}/advance`);
      }
      continue;
    }
    const limit = Math.max(1, state.config.limits.max_concurrent_sessions);
    const queue = [...pending];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (;;) {
        const company = queue.shift();
        if (company === undefined) return;
        const driver = drivers.get(company.id);
        if (driver === undefined) continue;
        if (driver.kind === 'llm') await runSession(company.id, driver, state, round);
        const after = drivers.get(company.id);
        if (after?.kind === 'bot') await runBot(company.id, after.strategy, state, round);
        acted.add(`${key}:${company.id}`);
      }
    });
    await Promise.all(workers);
  }
}

/** A deterministic unit float for bot decisions over HTTP, mirroring the in-process harness. */
function hashUnit(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
