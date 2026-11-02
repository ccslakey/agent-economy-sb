import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fold, reputationOf, runMetrics, scoreOf } from '@agent-economy/engine';
import {
  type ActionError,
  BotStrategy,
  type Company,
  CompanyId,
  Plan,
  RunConfig,
  RunId,
} from '@agent-economy/schema';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Game, type GameOptions } from './game.ts';
import { type RunRow, type Store, TOOL_OUTPUT_MAX_CHARS, type TraceRow } from './store.ts';

// The only boundary agents cross. Agent routes under /v1 take a bearer token per company and
// spend one tool call each. Admin routes create and drive runs and take the admin token.

export type ServerOptions = {
  store: Store;
  adminToken: string;
  docsDir: string;
  clock?: GameOptions['clock'];
};

type Agent = { game: Game; company: Company };

const statusOf = (code: ActionError['code']): number => {
  switch (code) {
    case 'ROUND_CLOSED':
    case 'BATCH_ALREADY_SUBMITTED':
    case 'CONTRACT_NOT_ACTIVE':
      return 409;
    case 'CONTRACT_NOT_FOUND':
      return 404;
    case 'NOT_A_PARTY':
      return 403;
    default:
      return 400;
  }
};

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const games = new Map<string, Game>();
  const tokens = new Map<string, { run: string; company: CompanyId }>();

  const gameOptions = (runId: RunId): GameOptions => ({
    persist: async (events) => {
      await options.store.append(runId, events);
      // Rounds advance on their own in a persistent run, so the game, not a route, ends the row.
      if (events.some((e) => e.type === 'run_ended'))
        await options.store.setRunStatus(runId, 'ended');
    },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const indexTokens = (run: RunRow): void => {
    for (const [company, token] of Object.entries(run.tokens)) {
      tokens.set(token, { run: run.id, company: CompanyId.parse(company) });
    }
  };

  for (const run of await options.store.listRuns()) {
    if (run.status === 'ended') continue;
    const [started, ...rest] = await options.store.events(run.id);
    if (started?.type !== 'run_started') continue;
    const game = new Game(started, rest, gameOptions(run.id));
    games.set(run.id, game);
    indexTokens(run);
  }

  const fail = (reply: FastifyReply, error: ActionError) =>
    reply.code(statusOf(error.code)).send(error);

  const agentOf = (request: FastifyRequest): Agent | null => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const hit = tokens.get(token);
    if (hit === undefined) return null;
    const game = games.get(hit.run);
    const company = game?.company(hit.company);
    if (game === undefined || company === undefined) return null;
    return { game, company };
  };

  // Agent routes. Every one but /v1/wait spends a tool call, so the budget is a hard cap on API use.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    const agent = agentOf(request);
    if (agent === null) return reply.code(401).send({ code: 'UNAUTHORIZED', reason: 'bad token' });
    // After the game ends an agent may still read its notes, plan, and the final state for its
    // debrief; only the round budget is closed, so writes keep failing with ROUND_CLOSED.
    const debrief = agent.game.state.phase.kind === 'ended' && request.method === 'GET';
    const free = request.url.startsWith('/v1/wait') || request.url.startsWith('/v1/calls');
    if (!free && !debrief) {
      const spent = agent.game.spend(agent.company.id);
      if (spent !== null) return fail(reply, spent);
    }
    request.agent = agent;
  });

  const WaitQuery = z.object({
    turn: z.coerce.number().int(),
    round: z.coerce.number().int(),
    timeout_ms: z.coerce.number().int().min(0).max(25_000).default(20_000),
  });

  /** Long poll for a persistent session: the next round's observation, or the end of the game. */
  app.get('/v1/wait', async (request, reply) => {
    const query = WaitQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ code: 'INVALID_ACTION', reason: 'pass turn and round' });
    }
    const { game, company } = request.agent;
    if (game.state.config.knobs.context_persistence !== 'persistent') {
      return reply.code(409).send({
        code: 'ROUND_CLOSED',
        reason: 'this run starts a fresh session each round; there is nothing to wait for',
      });
    }
    const { turn, round, timeout_ms } = query.data;
    return game.waitForRound(company.id, { turn, round }, timeout_ms);
  });

  const CallBody = z.object({
    tool: z.string().min(1).max(100),
    input: z.unknown(),
    output: z.string(),
    duration_ms: z.number().int().nonnegative(),
  });

  // The MCP server posts every tool call here so a run's record shows what each agent read and
  // did, with the turn and round as the API saw them. Free: it is the runner's log, not a move.
  app.post('/v1/calls', async (request, reply) => {
    const body = CallBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ code: 'INVALID_CALL', reason: 'bad tool call body' });
    }
    const { game, company } = request.agent;
    const call = {
      id: randomUUID(),
      run_id: game.id,
      company: company.id,
      turn: game.state.turn,
      round: game.state.phase.kind === 'round' ? game.state.phase.round : null,
      tool: body.data.tool,
      input: body.data.input ?? null,
      output: body.data.output.slice(0, TOOL_OUTPUT_MAX_CHARS),
      output_chars: body.data.output.length,
      duration_ms: body.data.duration_ms,
    };
    await options.store.putToolCall(call);
    return reply.code(201).send({ id: call.id });
  });

  app.get('/v1/observation', async (request) => {
    const { game, company } = request.agent;
    const fresh = game.company(company.id) ?? company;
    return game.observation(fresh);
  });

  app.post('/v1/actions', async (request, reply) => {
    const { game, company } = request.agent;
    const outcome = await game.submit(company.id, request.body);
    return outcome.ok ? { results: outcome.results } : fail(reply, outcome.error);
  });

  const TurnQuery = z.object({ turn: z.coerce.number().int().optional() });

  app.get('/v1/actions', async (request) => {
    const { game, company } = request.agent;
    const { turn } = TurnQuery.parse(request.query);
    const current = game.state.config.knobs.history === 'current';
    const own = game.log.filter(
      (e) =>
        (e.type === 'action_submitted' || e.type === 'action_rejected') &&
        e.actor === company.id &&
        (turn === undefined || e.turn === turn) &&
        (!current || e.turn === game.state.turn),
    );
    return {
      actions: own.map((e) =>
        e.type === 'action_rejected'
          ? {
              turn: e.turn,
              round: e.round,
              index: e.payload.index,
              action: e.payload.action,
              ok: false,
              code: e.payload.code,
              reason: e.payload.reason,
            }
          : e.type === 'action_submitted'
            ? {
                turn: e.turn,
                round: e.round,
                index: e.payload.index,
                action: e.payload.action,
                ok: true,
              }
            : null,
      ),
    };
  });

  const StatusQuery = z.object({ status: z.string().optional() });

  app.get('/v1/contracts', async (request) => {
    const { game, company } = request.agent;
    const { status } = StatusQuery.parse(request.query);
    const current = game.state.config.knobs.history === 'current';
    const mine = Object.values(game.state.contracts)
      .filter((k) => k.proposer === company.id || k.counterparty === company.id)
      .filter((k) => status === undefined || k.status.status === status)
      .filter((k) => !current || k.status.status === 'proposed' || k.status.status === 'active')
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return { contracts: mine };
  });

  app.get('/v1/messages', async (request) => {
    const { game, company } = request.agent;
    const { turn } = TurnQuery.parse(request.query);
    const current = game.state.config.knobs.history === 'current';
    const visible = game.state.messages.filter(
      (m) =>
        (turn === undefined || m.turn === turn) &&
        (!current || m.turn === game.state.turn) &&
        (m.channel.kind === 'public' || m.from === company.id || m.channel.to === company.id),
    );
    return { messages: visible };
  });

  app.get('/v1/market', async (request) => {
    return { clears: request.agent.game.state.market.clears };
  });

  const docFiles = async (): Promise<string[]> =>
    (await readdir(options.docsDir)).filter((f) => f.endsWith('.md')).sort();

  app.get('/v1/docs', async () => ({ files: await docFiles() }));

  app.get<{ Params: { path: string } }>('/v1/docs/:path', async (request, reply) => {
    const files = await docFiles();
    if (!files.includes(request.params.path)) {
      return reply.code(404).send({ code: 'NOT_FOUND', reason: `no doc ${request.params.path}` });
    }
    const text = await readFile(path.join(options.docsDir, request.params.path), 'utf8');
    return reply.type('text/markdown').send(text);
  });

  const memoryOff = { code: 'MEMORY_OFF' as const, reason: 'this run has notes and plan off' };

  app.get('/v1/notes', async (request) => {
    const { game, company } = request.agent;
    if (game.state.config.knobs.notes === 'off') return { text: '' };
    return { text: await options.store.getNotes(game.id, company.id) };
  });

  const NotesBody = z.object({ text: z.string() });

  app.get('/v1/plan', async (request) => {
    const { game, company } = request.agent;
    if (game.state.config.knobs.notes === 'off') return { plan: null };
    return { plan: await options.store.getPlan(game.id, company.id) };
  });

  app.put('/v1/plan', async (request, reply) => {
    const { game, company } = request.agent;
    if (game.state.config.knobs.notes === 'off') return fail(reply, memoryOff);
    const body = Plan.safeParse(request.body);
    if (!body.success) {
      return fail(reply, {
        code: 'INVALID_ACTION',
        reason: `plan needs early, mid, late, now, and thoughts, each under 600 characters: ${z.prettifyError(body.error)}`,
      });
    }
    await options.store.putPlan({
      run_id: game.id,
      company: company.id,
      turn: game.state.turn,
      round: game.state.phase.kind === 'round' ? game.state.phase.round : null,
      plan: body.data,
    });
    return { plan: body.data };
  });

  app.put('/v1/notes', async (request, reply) => {
    const { game, company } = request.agent;
    if (game.state.config.knobs.notes === 'off') return fail(reply, memoryOff);
    const body = NotesBody.safeParse(request.body);
    if (!body.success)
      return fail(reply, { code: 'INVALID_ACTION', reason: 'body must be { text }' });
    const max = game.state.config.limits.notes_max_chars;
    if (body.data.text.length > max) {
      return fail(reply, {
        code: 'NOTES_TOO_LONG',
        reason: `notes are capped at ${max} characters`,
      });
    }
    await options.store.putNotes(game.id, company.id, body.data.text);
    return { text: body.data.text };
  });

  app.post('/v1/bug_report', async (request, reply) => {
    const { game, company } = request.agent;
    const body = NotesBody.safeParse(request.body);
    if (!body.success)
      return fail(reply, { code: 'INVALID_ACTION', reason: 'body must be { text }' });
    await game.record({
      type: 'bug_report_filed',
      payload: { text: body.data.text },
      actor: company.id,
    });
    return { ok: true };
  });

  // Admin routes.
  const admin = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (request.headers['x-admin-token'] === options.adminToken) return true;
    await reply.code(401).send({ code: 'UNAUTHORIZED', reason: 'bad admin token' });
    return false;
  };

  const gameOrFail = (id: string, reply: FastifyReply): Game | null => {
    const game = games.get(id);
    if (game === undefined)
      void reply.code(404).send({ code: 'NOT_FOUND', reason: `no run ${id}` });
    return game ?? null;
  };

  app.post('/admin/runs', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const parsed = RunConfig.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ code: 'INVALID_CONFIG', reason: z.prettifyError(parsed.error) });
    }
    const runId = RunId.parse(`r-${randomUUID()}`);
    const row: RunRow = {
      id: runId,
      config: parsed.data,
      status: 'running',
      tokens: Object.fromEntries(parsed.data.population.map((p) => [p.id, randomUUID()])),
    };
    await options.store.createRun(row);
    const game = await Game.create(parsed.data, runId, gameOptions(runId));
    games.set(runId, game);
    indexTokens(row);
    return reply.code(201).send({ run_id: runId, tokens: row.tokens });
  });

  app.get('/admin/runs', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const runs = await options.store.listRuns();
    return {
      runs: await Promise.all(
        runs.map(async (r) => {
          const traces = await options.store.listTraces(r.id);
          const drivers = r.config.population.map((p) => p.driver);
          return {
            id: r.id,
            experiment_id: r.config.experiment_id,
            seed: r.config.seed,
            status: r.status,
            turn: games.get(r.id)?.state.turn ?? (await options.store.lastTurn(r.id)),
            phase: games.get(r.id)?.state.phase ?? null,
            knobs: r.config.knobs,
            population: {
              llm: drivers.filter((d) => d.kind === 'llm').length,
              bot: drivers.filter((d) => d.kind === 'bot').length,
              models: [...new Set(drivers.flatMap((d) => (d.kind === 'llm' ? [d.model] : [])))],
            },
            cost: {
              sessions: traces.length,
              tokens_in: traces.reduce((sum, t) => sum + t.tokens_in, 0),
              tokens_out: traces.reduce((sum, t) => sum + t.tokens_out, 0),
              cost_usd: traces.reduce((sum, t) => sum + t.cost_usd, 0),
            },
          };
        }),
      ),
    };
  });

  app.get<{ Params: { id: string } }>('/admin/runs/:id/state', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const game = gameOrFail(request.params.id, reply);
    return game === null ? undefined : game.state;
  });

  const SinceQuery = z.object({ after: z.coerce.number().int().optional() });

  // Ended runs have no live game, so their events and notes come straight from the store.
  app.get<{ Params: { id: string } }>('/admin/runs/:id/events', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const { after } = SinceQuery.parse(request.query);
    const game = games.get(request.params.id);
    if (game !== undefined) {
      return { events: game.log.filter((e) => after === undefined || e.seq > after) };
    }
    const id = RunId.safeParse(request.params.id);
    if (!id.success || (await options.store.getRun(id.data)) === null) {
      return reply.code(404).send({ code: 'NOT_FOUND', reason: `no run ${request.params.id}` });
    }
    return { events: await options.store.events(id.data, after ?? -1) };
  });

  app.post<{ Params: { id: string } }>('/admin/runs/:id/advance', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const game = gameOrFail(request.params.id, reply);
    if (game === null) return;
    const events = await game.advance();
    return { events, turn: game.state.turn, phase: game.state.phase };
  });

  const PauseBody = z.object({ reason: z.string().default('rate_limit') });

  app.post<{ Params: { id: string } }>('/admin/runs/:id/pause', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const game = gameOrFail(request.params.id, reply);
    if (game === null) return;
    await game.pause(PauseBody.parse(request.body ?? {}).reason);
    await options.store.setRunStatus(game.id, 'paused');
    return { phase: game.state.phase };
  });

  app.post<{ Params: { id: string } }>('/admin/runs/:id/resume', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const game = gameOrFail(request.params.id, reply);
    if (game === null) return;
    await game.resume();
    await options.store.setRunStatus(game.id, 'running');
    return { phase: game.state.phase };
  });

  app.get<{ Params: { id: string; company: string } }>(
    '/admin/runs/:id/notes/:company',
    async (request, reply) => {
      if (!(await admin(request, reply))) return;
      const id = RunId.safeParse(request.params.id);
      const company = CompanyId.safeParse(request.params.company);
      if (!id.success || !company.success || (await options.store.getRun(id.data)) === null) {
        return reply.code(404).send({ code: 'NOT_FOUND', reason: 'no such run or company' });
      }
      return { text: await options.store.getNotes(id.data, company.data) };
    },
  );

  app.get<{ Params: { id: string } }>('/admin/runs/:id/tokens', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const id = RunId.safeParse(request.params.id);
    const run = id.success ? await options.store.getRun(id.data) : null;
    if (run === null) return reply.code(404).send({ code: 'NOT_FOUND', reason: 'no such run' });
    return { tokens: run.tokens };
  });

  const TraceBody = z.object({
    company: CompanyId,
    turn: z.number().int(),
    round: z.number().int().nullable(),
    kind: z.enum(['round', 'farming']),
    session_id: z.string().nullable(),
    model: z.string().nullable(),
    result: z.record(z.string(), z.unknown()),
    tokens_in: z.number().int(),
    tokens_out: z.number().int(),
    cost_usd: z.number(),
    duration_ms: z.number().int(),
  });

  app.post<{ Params: { id: string } }>('/admin/runs/:id/traces', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const id = RunId.safeParse(request.params.id);
    const body = TraceBody.safeParse(request.body);
    if (!id.success || !body.success) {
      return reply.code(400).send({ code: 'INVALID_TRACE', reason: 'bad run id or trace body' });
    }
    const trace = { id: randomUUID(), run_id: id.data, ...body.data };
    await options.store.putTrace(trace);
    const game = games.get(id.data);
    if (game !== undefined) {
      await game.record({
        type: 'agent_trace_recorded',
        payload: { trace_id: trace.id },
        actor: body.data.company,
      });
    }
    return reply.code(201).send({ id: trace.id });
  });

  const CompanyQuery = z.object({ company: CompanyId.optional() });

  app.get<{ Params: { id: string } }>('/admin/runs/:id/traces', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const id = RunId.safeParse(request.params.id);
    if (!id.success) return reply.code(404).send({ code: 'NOT_FOUND', reason: 'no such run' });
    const { company } = CompanyQuery.parse(request.query);
    return { traces: await options.store.listTraces(id.data, company) };
  });

  app.get<{ Params: { id: string } }>('/admin/runs/:id/calls', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const id = RunId.safeParse(request.params.id);
    if (!id.success) return reply.code(404).send({ code: 'NOT_FOUND', reason: 'no such run' });
    const { company } = CompanyQuery.parse(request.query);
    return { calls: await options.store.listToolCalls(id.data, company) };
  });

  /** Sessions, tokens, cost, and latency rolled up by company and by model. The traces themselves stay on the traces route. */
  app.get<{ Params: { id: string } }>('/admin/runs/:id/cost', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const id = RunId.safeParse(request.params.id);
    if (!id.success) return reply.code(404).send({ code: 'NOT_FOUND', reason: 'no such run' });
    const traces = await options.store.listTraces(id.data);
    type Bucket = {
      sessions: number;
      tokens_in: number;
      tokens_out: number;
      cost_usd: number;
      duration_ms: number;
    };
    const rollup = (key: (t: TraceRow) => string): Record<string, Bucket> => {
      const out: Record<string, Bucket> = {};
      for (const t of traces) {
        const bucket = out[key(t)] ?? {
          sessions: 0,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          duration_ms: 0,
        };
        out[key(t)] = bucket;
        bucket.sessions += 1;
        bucket.tokens_in += t.tokens_in;
        bucket.tokens_out += t.tokens_out;
        bucket.cost_usd += t.cost_usd;
        bucket.duration_ms += t.duration_ms;
      }
      return out;
    };
    return {
      by_company: rollup((t) => t.company),
      by_model: rollup((t) => t.model ?? 'unknown'),
      by_turn: rollup((t) => String(t.turn)),
    };
  });

  const ReplaceBody = z.object({ company: CompanyId, strategy: BotStrategy, reason: z.string() });

  app.post<{ Params: { id: string } }>('/admin/runs/:id/replace', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const game = gameOrFail(request.params.id, reply);
    if (game === null) return;
    const body = ReplaceBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ code: 'INVALID_ACTION', reason: 'bad body' });
    await game.record({
      type: 'agent_replaced_by_bot',
      payload: { strategy: body.data.strategy, reason: body.data.reason },
      actor: body.data.company,
    });
    return { ok: true };
  });

  app.get<{ Params: { id: string; company: string } }>(
    '/admin/runs/:id/plans/:company',
    async (request, reply) => {
      if (!(await admin(request, reply))) return;
      const id = RunId.safeParse(request.params.id);
      const company = CompanyId.safeParse(request.params.company);
      if (!id.success || !company.success) {
        return reply.code(404).send({ code: 'NOT_FOUND', reason: 'no such run or company' });
      }
      return { plans: await options.store.listPlans(id.data, company.data) };
    },
  );

  app.get<{ Params: { id: string } }>('/admin/runs/:id/metrics', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const id = RunId.safeParse(request.params.id);
    const [started, ...rest] = id.success ? await options.store.events(id.data) : [];
    if (started?.type !== 'run_started') {
      return reply.code(404).send({ code: 'NOT_FOUND', reason: 'no such run' });
    }
    return runMetrics(started, rest);
  });

  // The end-of-run report: scores, each company's last plan and thoughts, its notes, every bug
  // report it filed, and its farming answer. Built from the store so it works for ended runs.
  app.get<{ Params: { id: string } }>('/admin/runs/:id/report', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const id = RunId.safeParse(request.params.id);
    const run = id.success ? await options.store.getRun(id.data) : null;
    if (!id.success || run === null) {
      return reply.code(404).send({ code: 'NOT_FOUND', reason: 'no such run' });
    }
    const [started, ...rest] = await options.store.events(id.data);
    if (started?.type !== 'run_started') {
      return reply.code(404).send({ code: 'NOT_FOUND', reason: 'run has no events' });
    }
    const state = fold(started, rest);
    const traces = await options.store.listTraces(id.data);
    const companies = await Promise.all(
      Object.values(state.companies)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(async (c) => {
          const entry = run.config.population.find((p) => p.id === c.id);
          const farming = traces.findLast((t) => t.company === c.id && t.kind === 'farming');
          return {
            id: c.id,
            name: c.name,
            roles: c.roles,
            driver: entry?.driver ?? null,
            score: scoreOf(state, c),
            standing: c.standing,
            reputation: reputationOf(state, c),
            plan: await options.store.getPlan(id.data, c.id),
            plan_revisions: (await options.store.listPlans(id.data, c.id)).length,
            notes: await options.store.getNotes(id.data, c.id),
            bug_reports: rest.flatMap((e) =>
              e.type === 'bug_report_filed' && e.actor === c.id
                ? [{ turn: e.turn, round: e.round, text: e.payload.text }]
                : [],
            ),
            farming:
              farming !== undefined && typeof farming.result.result === 'string'
                ? farming.result.result
                : null,
            sessions: traces.filter((t) => t.company === c.id).length,
          };
        }),
    );
    return {
      run_id: id.data,
      experiment_id: run.config.experiment_id,
      status: run.status,
      turn: state.turn,
      phase: state.phase,
      companies,
    };
  });

  app.addHook('onClose', async () => {
    for (const game of games.values()) game.close();
  });

  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    agent: Agent;
  }
}
