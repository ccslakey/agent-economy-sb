import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer, MemoryStore } from '@agent-economy/api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classify,
  cliArgs,
  interpret,
  type SessionRequest,
  type SessionResult,
  type Spawner,
} from './claude.ts';
import { drive } from './drive.ts';
import { GameClient } from './mcp.ts';

// The runner against a real API on an ephemeral port, with a fake spawner standing in for
// Claude Code. The fake reads the MCP config the runner wrote, so it acts through the same
// token and URL a real session would.

const config = {
  seed: 4,
  experiment_id: 'drive-test',
  population: [
    {
      id: 'c01',
      name: 'Ironreach',
      role: 'miner',
      driver: {
        kind: 'llm',
        model: 'fake',
        effort: 'low',
        harness_version: 1,
        prompt_variant: 'neutral',
      },
    },
    {
      id: 'c05',
      name: 'Emberworks',
      role: 'smelter',
      driver: {
        kind: 'llm',
        model: 'fake',
        effort: 'low',
        harness_version: 1,
        prompt_variant: 'neutral',
      },
    },
    {
      id: 'c09',
      name: 'Anvilgate',
      role: 'toolmaker',
      driver: { kind: 'bot', strategy: 'honest_trader' },
    },
  ],
  economy: { demand_noise: 0 },
  knobs: { horizon: { kind: 'fixed', last_turn: 2 }, context_persistence: 'per_turn' },
  limits: { round_wall_clock_seconds: 3600, max_concurrent_sessions: 2, auto_advance: false },
};

/** A session that plays like a tiny agent: one order per round, then a note. */
async function fakeAgent(request: SessionRequest): Promise<SessionResult> {
  const mcp = JSON.parse(await readFile(request.mcpConfigPath, 'utf8')) as {
    mcpServers: { game: { env: { AGENT_ECONOMY_URL: string; AGENT_ECONOMY_TOKEN: string } } };
  };
  const env = mcp.mcpServers.game.env;
  const client = new GameClient({ baseUrl: env.AGENT_ECONOMY_URL, token: env.AGENT_ECONOMY_TOKEN });
  if (request.prompt.startsWith('The game has ended')) {
    return {
      ok: true,
      sessionId: 'farm',
      result: 'nothing was confusing',
      raw: { kind: 'farming' },
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.01,
      durationMs: 5,
    };
  }
  const seen = JSON.parse(await client.call('GET', '/v1/observation')) as {
    you: { roles: string[] };
  };
  const action =
    seen.you.roles[0] === 'miner'
      ? { type: 'extract', from: { kind: 'ore_pit' }, qty: 12 }
      : { type: 'produce', good: 'ingot', qty: 6 };
  await client.call('POST', '/v1/actions', { actions: [action] });
  await client.call('PUT', '/v1/notes', { text: `prompt was: ${request.prompt.slice(0, 40)}` });
  return {
    ok: true,
    sessionId: `s-${request.resume ?? 'new'}`,
    result: 'submitted',
    raw: { prompt: request.prompt, resume: request.resume ?? null },
    tokensIn: 100,
    tokensOut: 20,
    costUsd: 0.02,
    durationMs: 9,
  };
}

/** A session that plays the whole game: act, wait for the next round, repeat, then answer. */
async function fakeAwakeAgent(request: SessionRequest): Promise<SessionResult> {
  const mcp = JSON.parse(await readFile(request.mcpConfigPath, 'utf8')) as {
    mcpServers: { game: { env: { AGENT_ECONOMY_URL: string; AGENT_ECONOMY_TOKEN: string } } };
  };
  const env = mcp.mcpServers.game.env;
  const client = new GameClient({ baseUrl: env.AGENT_ECONOMY_URL, token: env.AGENT_ECONOMY_TOKEN });
  type Seen = { turn: number; round: number; you: { roles: string[] } };
  let seen = JSON.parse(await client.call('GET', '/v1/observation')) as Seen;
  let rounds = 0;
  for (;;) {
    const action =
      seen.you.roles[0] === 'miner'
        ? { type: 'extract', from: { kind: 'ore_pit' }, qty: 12 }
        : { type: 'produce', good: 'ingot', qty: 6 };
    await client.call('POST', '/v1/actions', { actions: [action] });
    rounds += 1;
    let waited: { status: string; observation?: Seen };
    do {
      waited = JSON.parse(
        await client.call('GET', `/v1/wait?turn=${seen.turn}&round=${seen.round}&timeout_ms=200`),
      ) as typeof waited;
    } while (waited.status === 'waiting');
    if (waited.status === 'ended') {
      return {
        ok: true,
        sessionId: request.sessionId ?? 'awake',
        result: `played ${rounds} rounds awake`,
        raw: { prompt: request.prompt, sessionId: request.sessionId ?? null },
        tokensIn: 500,
        tokensOut: 80,
        costUsd: 0.1,
        durationMs: 40,
      };
    }
    seen = waited.observation as Seen;
  }
}

let app: Awaited<ReturnType<typeof buildServer>> | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(spawner: Spawner, quotaWaitMs = 1, runConfig: object = config) {
  const store = new MemoryStore();
  app = await buildServer({
    store,
    adminToken: 'admin',
    docsDir: path.resolve(import.meta.dirname, '../../../docs/agent'),
  });
  const api = await app.listen({ port: 0, host: '127.0.0.1' });
  const created = await app.inject({
    method: 'POST',
    url: '/admin/runs',
    headers: { 'x-admin-token': 'admin' },
    payload: runConfig,
  });
  const { run_id } = created.json() as { run_id: string };
  const lines: string[] = [];
  const result = await drive({
    api,
    adminToken: 'admin',
    runId: run_id,
    spawner,
    systemPrompt: 'neutral',
    workDir: await mkdtemp(path.join(os.tmpdir(), 'drive-test-')),
    sleep: async () => undefined,
    log: (line) => lines.push(line),
    quotaWaitMs,
  });
  const events = await store.events(run_id as never);
  const traces = await store.listTraces(run_id as never);
  return { result, events, traces, lines, store, run_id };
}

/** The run ended, and the only events after it are traces, whose timing against the last advance is a race. */
function expectEnded(events: { type: string }[]): void {
  const at = events.findIndex((e) => e.type === 'run_ended');
  expect(at).toBeGreaterThan(0);
  expect(events.slice(at + 1).every((e) => e.type === 'agent_trace_recorded')).toBe(true);
}

describe('drive', () => {
  it('plays LLM companies through sessions and bots through the API until the run ends', async () => {
    const { result, events, traces } = await start(fakeAgent);
    expect(result.turns).toBe(2);
    expect(result.replaced).toEqual([]);
    expect(result.report).toMatchObject({
      turn: 2,
      companies: [{ id: 'c01', sessions: 7 }, { id: 'c05' }, { id: 'c09', sessions: 0 }],
    });
    expect(result.sessions).toBe(2 * 2 * 3 + 2);
    expect(traces.filter((t) => t.kind === 'round')).toHaveLength(12);
    expect(traces.filter((t) => t.kind === 'farming')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'agent_trace_recorded')).toHaveLength(14);
    expectEnded(events);
    const resumed = traces.filter(
      (t) => t.kind === 'round' && (t.result as { resume: string | null }).resume !== null,
    );
    expect(resumed).toHaveLength(2 * 2 * 2);
    const bot = events.filter((e) => e.type === 'action_submitted' && e.actor === 'c09');
    expect(bot.length).toBeGreaterThan(0);
  });

  it('plays a persistent run with one session per company that waits between rounds', async () => {
    const awake = {
      ...config,
      knobs: { ...config.knobs, context_persistence: 'persistent' },
      limits: { ...config.limits, auto_advance: true },
    };
    const { result, events, traces } = await start(fakeAwakeAgent, 1, awake);
    expect(result.turns).toBe(2);
    expect(result.replaced).toEqual([]);
    expect(events.some((e) => e.type === 'run_ended')).toBe(true);
    expect(
      events.filter((e) => e.type === 'extraction_completed' && e.actor === 'c01'),
    ).toHaveLength(2);
    expect(events.some((e) => e.type === 'production_completed' && e.actor === 'c09')).toBe(true);
    expect(traces.filter((t) => t.kind === 'round')).toHaveLength(0);
    const farming = traces.filter((t) => t.kind === 'farming');
    expect(farming.map((t) => t.company).sort()).toEqual(['c01', 'c05']);
    expect(
      farming.every((t) => typeof (t.result as { sessionId: unknown }).sessionId === 'string'),
    ).toBe(true);
    const first = farming[0]?.result as { prompt: string } | undefined;
    expect(first?.prompt).toContain('plays the whole game');
  });
  it('pauses the run on a quota error and resumes before retrying', async () => {
    let calls = 0;
    const flaky: Spawner = async (request) => {
      calls += 1;
      if (calls === 2)
        return {
          ok: false,
          kind: 'quota',
          message: 'You have hit your usage limit',
          raw: {},
          durationMs: 1,
        };
      return fakeAgent(request);
    };
    const { events, lines } = await start(flaky);
    const types = events.map((e) => e.type);
    expect(types.indexOf('run_paused')).toBeGreaterThan(0);
    expect(types.indexOf('run_resumed')).toBe(types.indexOf('run_paused') + 1);
    expect(lines.some((l) => l.includes('quota limit'))).toBe(true);
    expectEnded(events);
  });

  it('hands a company to the honest trader bot after repeated failures', async () => {
    const broken: Spawner = async (request) => {
      if (
        request.mcpConfigPath.endsWith('mcp-c05.json') &&
        !request.prompt.startsWith('The game')
      ) {
        return { ok: false, kind: 'error', message: 'MCP server crashed', raw: {}, durationMs: 1 };
      }
      return fakeAgent(request);
    };
    const { result, events } = await start(broken);
    expect(result.replaced).toEqual(['c05']);
    const replaced = events.find((e) => e.type === 'agent_replaced_by_bot');
    expect(replaced?.actor).toBe('c05');
    expect(replaced?.type === 'agent_replaced_by_bot' && replaced.payload.strategy).toBe(
      'honest_trader',
    );
    expect(
      events.filter((e) => e.type === 'action_submitted' && e.actor === 'c05').length,
    ).toBeGreaterThan(0);
    expectEnded(events);
  });
});

describe('claude adapter', () => {
  it('builds the headless command line with only the game tools', () => {
    const args = cliArgs({
      prompt: 'go',
      systemPrompt: 'sys',
      model: 'sonnet',
      effort: 'low',
      mcpConfigPath: '/tmp/m.json',
      cwd: '/tmp',
      resume: 'abc',
    });
    expect(args).toEqual([
      '-p',
      'go',
      '--model',
      'sonnet',
      '--effort',
      'low',
      '--append-system-prompt',
      'sys',
      '--mcp-config',
      '/tmp/m.json',
      '--strict-mcp-config',
      '--tools',
      '',
      '--allowedTools',
      'mcp__game__*',
      '--permission-mode',
      'dontAsk',
      '--output-format',
      'json',
      '--resume',
      'abc',
    ]);
  });
  it('reads the JSON result and classifies failures', () => {
    const ok = interpret(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        result: 'done',
        total_cost_usd: 0.05,
        duration_ms: 900,
        usage: { input_tokens: 12, output_tokens: 600, cache_read_input_tokens: 30000 },
      }),
      '',
      0,
      1000,
    );
    expect(ok).toMatchObject({
      ok: true,
      sessionId: 's1',
      tokensIn: 30012,
      tokensOut: 600,
      costUsd: 0.05,
      durationMs: 900,
    });
    const quota = interpret(
      JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'Rate limit reached',
      }),
      '',
      1,
      10,
    );
    expect(quota).toMatchObject({ ok: false, kind: 'quota' });
    const crash = interpret('', 'command not found: claude', 127, 10);
    expect(crash).toMatchObject({ ok: false, kind: 'error', message: 'command not found: claude' });
    expect(classify('429 Too Many Requests')).toBe('quota');
    expect(classify('MCP server failed')).toBe('error');
  });
});
