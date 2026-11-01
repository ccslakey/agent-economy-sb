import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type ActionError, type Company, CompanyId, RunConfig, RunId } from '@agent-economy/schema';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Game, type GameOptions } from './game.ts';
import type { RunRow, Store } from './store.ts';

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
    persist: (events) => options.store.append(runId, events),
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

  // Agent routes. Every one spends a tool call, so the agent's budget is a hard cap on API use.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    const agent = agentOf(request);
    if (agent === null) return reply.code(401).send({ code: 'UNAUTHORIZED', reason: 'bad token' });
    const spent = agent.game.spend(agent.company.id);
    if (spent !== null) return fail(reply, spent);
    request.agent = agent;
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
    const own = game.log.filter(
      (e) =>
        (e.type === 'action_submitted' || e.type === 'action_rejected') &&
        e.actor === company.id &&
        (turn === undefined || e.turn === turn),
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
    const mine = Object.values(game.state.contracts)
      .filter((k) => k.proposer === company.id || k.counterparty === company.id)
      .filter((k) => status === undefined || k.status.status === status)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return { contracts: mine };
  });

  app.get('/v1/messages', async (request) => {
    const { game, company } = request.agent;
    const { turn } = TurnQuery.parse(request.query);
    const visible = game.state.messages.filter(
      (m) =>
        (turn === undefined || m.turn === turn) &&
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

  app.get('/v1/notes', async (request) => {
    const { game, company } = request.agent;
    return { text: await options.store.getNotes(game.id, company.id) };
  });

  const NotesBody = z.object({ text: z.string() });

  app.put('/v1/notes', async (request, reply) => {
    const { game, company } = request.agent;
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
      runs: runs.map((r) => ({
        id: r.id,
        experiment_id: r.config.experiment_id,
        seed: r.config.seed,
        status: r.status,
        turn: games.get(r.id)?.state.turn ?? null,
        phase: games.get(r.id)?.state.phase ?? null,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/admin/runs/:id/state', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const game = gameOrFail(request.params.id, reply);
    return game === null ? undefined : game.state;
  });

  const SinceQuery = z.object({ after: z.coerce.number().int().optional() });

  app.get<{ Params: { id: string } }>('/admin/runs/:id/events', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const { after } = SinceQuery.parse(request.query);
    const game = gameOrFail(request.params.id, reply);
    if (game === null) return;
    return { events: game.log.filter((e) => after === undefined || e.seq > after) };
  });

  app.post<{ Params: { id: string } }>('/admin/runs/:id/advance', async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const game = gameOrFail(request.params.id, reply);
    if (game === null) return;
    const events = await game.advance();
    if (game.state.phase.kind === 'ended') await options.store.setRunStatus(game.id, 'ended');
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
