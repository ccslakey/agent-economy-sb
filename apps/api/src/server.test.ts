import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.ts';
import { MemoryStore } from './store.ts';

// Drives the API the way the runner will: admin creates a run, agents act with bearer tokens.

const docsDir = path.resolve(import.meta.dirname, '../../../docs/agent');
const bot = { kind: 'bot', strategy: 'honest_trader' };
const config = {
  seed: 3,
  experiment_id: 'api-test',
  population: [
    { id: 'c01', name: 'Ironreach', role: 'miner', driver: bot },
    { id: 'c05', name: 'Emberworks', role: 'smelter', driver: bot },
  ],
  economy: {
    demand_noise: 0,
    starting_inventory: {
      miner: { ore: 12 },
      logger: {},
      smelter: { ore: 12 },
      mill: {},
      toolmaker: {},
      furniture_maker: {},
    },
  },
  knobs: { horizon: { kind: 'fixed', last_turn: 2 } },
  limits: { round_tool_calls: 8, round_wall_clock_seconds: 3600 },
};

/** A clock the test controls: timers never fire on their own. */
const frozenClock = () => {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    setTimeout: (fn: () => void) => {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    fire: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
  };
};

let app: FastifyInstance | null = null;
const api = (): FastifyInstance => {
  if (app === null) throw new Error('no server running');
  return app;
};
afterEach(async () => {
  await app?.close();
  app = null;
});

async function startRun(
  store = new MemoryStore(),
  clock = frozenClock(),
  payload: object = config,
) {
  app = await buildServer({ store, adminToken: 'admin', docsDir, clock });
  const created = await app.inject({
    method: 'POST',
    url: '/admin/runs',
    headers: { 'x-admin-token': 'admin' },
    payload,
  });
  expect(created.statusCode).toBe(201);
  const { run_id, tokens } = created.json() as { run_id: string; tokens: Record<string, string> };
  const as = (company: string) => ({ authorization: `Bearer ${tokens[company] ?? ''}` });
  const advance = () =>
    api().inject({
      method: 'POST',
      url: `/admin/runs/${run_id}/advance`,
      headers: { 'x-admin-token': 'admin' },
    });
  return { run_id, tokens, as, advance, store, clock };
}

describe('agent routes', () => {
  it('refuses a bad token and serves the observation for a good one', async () => {
    const run = await startRun();
    const anon = await api().inject({ method: 'GET', url: '/v1/observation' });
    expect(anon.statusCode).toBe(401);
    const seen = await api().inject({
      method: 'GET',
      url: '/v1/observation',
      headers: run.as('c01'),
    });
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({
      turn: 1,
      round: 1,
      you: { id: 'c01', roles: ['miner'], cash: 600, capacity: { ore: 12 } },
      round_budget: { tool_calls_left: 7 },
    });
  });

  it('submits a batch once per round and reports per-action results in order', async () => {
    const run = await startRun();
    const submitted = await api().inject({
      method: 'POST',
      url: '/v1/actions',
      headers: run.as('c01'),
      payload: {
        actions: [
          { type: 'extract', from: { kind: 'ore_pit' }, qty: 12 },
          { type: 'produce', good: 'ingot', qty: 1 },
          { type: 'scrap', good: 'ore', qty: 'many' },
        ],
      },
    });
    expect(submitted.json()).toEqual({
      results: [
        { ok: true },
        { ok: false, code: 'NOT_LICENSED', reason: 'ingot needs the smelter license' },
        { ok: false, code: 'INVALID_ACTION', reason: expect.stringContaining('qty') },
      ],
    });
    const again = await api().inject({
      method: 'POST',
      url: '/v1/actions',
      headers: run.as('c01'),
      payload: { actions: [{ type: 'scrap', good: 'ore', qty: 1 }] },
    });
    expect(again.json()).toEqual({
      results: [{ ok: false, code: 'BATCH_ALREADY_SUBMITTED', reason: 'one batch per round' }],
    });
    const history = await api().inject({
      method: 'GET',
      url: '/v1/actions?turn=1',
      headers: run.as('c01'),
    });
    expect((history.json() as { actions: unknown[] }).actions).toHaveLength(3);
  });

  it('spends the tool-call budget and closes the round when it is gone', async () => {
    const run = await startRun();
    for (let i = 0; i < 8; i++) {
      const r = await api().inject({ method: 'GET', url: '/v1/market', headers: run.as('c01') });
      expect(r.statusCode).toBe(200);
    }
    const ninth = await api().inject({
      method: 'GET',
      url: '/v1/observation',
      headers: run.as('c01'),
    });
    expect(ninth.statusCode).toBe(409);
    expect(ninth.json()).toMatchObject({ code: 'ROUND_CLOSED' });
  });

  it('leaves the round open after every submission when auto_advance is off', async () => {
    const store = new MemoryStore();
    app = await buildServer({ store, adminToken: 'admin', docsDir, clock: frozenClock() });
    const created = await api().inject({
      method: 'POST',
      url: '/admin/runs',
      headers: { 'x-admin-token': 'admin' },
      payload: { ...config, limits: { ...config.limits, auto_advance: false } },
    });
    const { run_id, tokens } = created.json() as { run_id: string; tokens: Record<string, string> };
    for (const company of ['c01', 'c05']) {
      await api().inject({
        method: 'POST',
        url: '/v1/actions',
        headers: { authorization: `Bearer ${tokens[company] ?? ''}` },
        payload: { actions: [] },
      });
    }
    const still = await api().inject({
      method: 'GET',
      url: `/admin/runs/${run_id}/state`,
      headers: { 'x-admin-token': 'admin' },
    });
    expect(still.json()).toMatchObject({ turn: 1, phase: { kind: 'round', round: 1 } });
  });

  it('advances on its own once every company has submitted, and on the wall clock', async () => {
    const run = await startRun();
    await api().inject({
      method: 'POST',
      url: '/v1/actions',
      headers: run.as('c01'),
      payload: { actions: [] },
    });
    let seen = await api().inject({
      method: 'GET',
      url: '/v1/observation',
      headers: run.as('c05'),
    });
    expect(seen.json()).toMatchObject({ round: 1 });
    await api().inject({
      method: 'POST',
      url: '/v1/actions',
      headers: run.as('c05'),
      payload: { actions: [] },
    });
    seen = await api().inject({ method: 'GET', url: '/v1/observation', headers: run.as('c05') });
    expect(seen.json()).toMatchObject({ round: 2, round_budget: { tool_calls_left: 7 } });
    run.clock.fire();
    await new Promise((r) => setImmediate(r));
    seen = await api().inject({ method: 'GET', url: '/v1/observation', headers: run.as('c05') });
    expect(seen.json()).toMatchObject({ round: 3 });
  });

  it('treats a persistent session waiting for the next round as passing this one', async () => {
    const run = await startRun(new MemoryStore(), frozenClock(), {
      ...config,
      knobs: { ...config.knobs, context_persistence: 'persistent' },
    });
    await api().inject({
      method: 'POST',
      url: '/v1/actions',
      headers: run.as('c01'),
      payload: { actions: [] },
    });
    const waited = await api().inject({
      method: 'GET',
      url: '/v1/wait?turn=1&round=1&timeout_ms=0',
      headers: run.as('c05'),
    });
    expect(waited.json()).toMatchObject({ status: 'round', turn: 1, round: 2 });
    const again = await api().inject({
      method: 'POST',
      url: '/v1/actions',
      headers: run.as('c05'),
      payload: { actions: [] },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ results: [] });
  });

  it('marks a run ended in the store when the wall clock plays it out', async () => {
    const run = await startRun(new MemoryStore(), frozenClock(), {
      ...config,
      knobs: { ...config.knobs, context_persistence: 'persistent' },
    });
    for (let i = 0; i < 6; i++) {
      run.clock.fire();
      await new Promise((r) => setImmediate(r));
    }
    expect((await run.store.listRuns())[0]).toMatchObject({ status: 'ended' });
  });

  it('runs the operations step after round three and ends on the fixed last turn', async () => {
    const run = await startRun();
    await api().inject({
      method: 'POST',
      url: '/v1/actions',
      headers: run.as('c05'),
      payload: { actions: [{ type: 'produce', good: 'ingot', qty: 6 }] },
    });
    await run.advance();
    await run.advance();
    const third = await run.advance();
    expect(third.json()).toMatchObject({ turn: 2, phase: { kind: 'round', round: 1 } });
    const seen = await api().inject({
      method: 'GET',
      url: '/v1/observation',
      headers: run.as('c05'),
    });
    expect(seen.json()).toMatchObject({
      turn: 2,
      you: { inventory: { ingot: 6 }, cash: 600 - 40 - 6 },
    });
    const market = await api().inject({ method: 'GET', url: '/v1/market', headers: run.as('c05') });
    expect(market.json()).toEqual({
      clears: [
        { turn: 1, good: 'tool', qty: 0, price: 240, sales: {} },
        { turn: 1, good: 'furniture', qty: 0, price: 640, sales: {} },
      ],
    });
    for (let i = 0; i < 3; i++) await run.advance();
    const list = await api().inject({
      method: 'GET',
      url: '/admin/runs',
      headers: { 'x-admin-token': 'admin' },
    });
    expect((list.json() as { runs: { status: string; phase: unknown }[] }).runs[0]).toMatchObject({
      status: 'ended',
      phase: { kind: 'ended' },
      turn: 2,
      knobs: { enforcement: 'on' },
      population: { llm: 0, bot: 2, models: [] },
      cost: { sessions: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    });
    const debrief = await api().inject({
      method: 'GET',
      url: '/v1/notes',
      headers: run.as('c05'),
    });
    expect(debrief.statusCode).toBe(200);
    const closed = await api().inject({
      method: 'POST',
      url: '/v1/actions',
      headers: run.as('c05'),
      payload: { actions: [] },
    });
    expect(closed.statusCode).toBe(409);
    await api().close();
    app = await buildServer({
      store: run.store,
      adminToken: 'admin',
      docsDir,
      clock: frozenClock(),
    });
    const archived = await api().inject({
      method: 'GET',
      url: `/admin/runs/${run.run_id}/events?after=0`,
      headers: { 'x-admin-token': 'admin' },
    });
    expect((archived.json() as { events: { type: string }[] }).events.at(-1)?.type).toBe(
      'run_ended',
    );
    const relisted = await api().inject({
      method: 'GET',
      url: '/admin/runs',
      headers: { 'x-admin-token': 'admin' },
    });
    expect((relisted.json() as { runs: { turn: number | null }[] }).runs[0]?.turn).toBe(2);
    const metrics = await api().inject({
      method: 'GET',
      url: `/admin/runs/${run.run_id}/metrics`,
      headers: { 'x-admin-token': 'admin' },
    });
    expect(metrics.json()).toMatchObject({
      turns: 2,
      companies: 2,
      bankruptcies: 0,
      contracts: { proposed: 0, accepted: 0, completed: 0, defaulted: 0 },
      default_rate: null,
      penalties: 0,
      messages: { public: 0, dm: 0 },
    });
  });

  it('delivers contracts and messages at round end and lists them', async () => {
    const run = await startRun();
    await api().inject({
      method: 'POST',
      url: '/v1/actions',
      headers: run.as('c01'),
      payload: {
        actions: [
          { type: 'post_message', text: 'ore for sale' },
          { type: 'send_dm', to: 'c05', text: '4 for 60?' },
          {
            type: 'propose_contract',
            counterparty: 'c05',
            terms_text: '',
            obligations: [{ kind: 'goods', by: 'proposer', good: 'ore', qty: 4, due_turn: 2 }],
          },
        ],
      },
    });
    await run.advance();
    const seen = await api().inject({
      method: 'GET',
      url: '/v1/observation',
      headers: run.as('c05'),
    });
    expect(seen.json()).toMatchObject({
      round: 2,
      contracts: { proposed_to_you: ['k1'], changed_since_last_round: ['k1'] },
      messages: {
        public: [{ from: 'c01', text: 'ore for sale' }],
        dms: [{ from: 'c01', channel: { kind: 'dm', to: 'c05' }, text: '4 for 60?' }],
      },
    });
    const contracts = await api().inject({
      method: 'GET',
      url: '/v1/contracts?status=proposed',
      headers: run.as('c05'),
    });
    expect(
      (contracts.json() as { contracts: { id: string }[] }).contracts.map((k) => k.id),
    ).toEqual(['k1']);
    const messages = await api().inject({
      method: 'GET',
      url: '/v1/messages?turn=1',
      headers: run.as('c05'),
    });
    expect((messages.json() as { messages: unknown[] }).messages).toHaveLength(2);
  });

  it('serves docs, caps notes, and records bug reports', async () => {
    const run = await startRun();
    const docs = await api().inject({ method: 'GET', url: '/v1/docs', headers: run.as('c01') });
    expect(docs.json()).toEqual({ files: ['api.md', 'contracts.md', 'recipes.md', 'rules.md'] });
    const rules = await api().inject({
      method: 'GET',
      url: '/v1/docs/rules.md',
      headers: run.as('c01'),
    });
    expect(rules.headers['content-type']).toContain('text/markdown');
    expect(rules.body).toContain('# Rules');
    const missing = await api().inject({
      method: 'GET',
      url: '/v1/docs/..%2F..%2Fpackage.json',
      headers: run.as('c01'),
    });
    expect(missing.statusCode).toBe(404);

    const tooLong = await api().inject({
      method: 'PUT',
      url: '/v1/notes',
      headers: run.as('c01'),
      payload: { text: 'x'.repeat(4001) },
    });
    expect(tooLong.json()).toMatchObject({ code: 'NOTES_TOO_LONG' });
    await api().inject({
      method: 'PUT',
      url: '/v1/notes',
      headers: run.as('c01'),
      payload: { text: 'trust c05' },
    });
    const notes = await api().inject({ method: 'GET', url: '/v1/notes', headers: run.as('c01') });
    expect(notes.json()).toEqual({ text: 'trust c05' });
    const adminNotes = await api().inject({
      method: 'GET',
      url: `/admin/runs/${run.run_id}/notes/c01`,
      headers: { 'x-admin-token': 'admin' },
    });
    expect(adminNotes.json()).toEqual({ text: 'trust c05' });

    await api().inject({
      method: 'POST',
      url: '/v1/bug_report',
      headers: run.as('c01'),
      payload: { text: 'deliver confused me' },
    });
    const events = await api().inject({
      method: 'GET',
      url: `/admin/runs/${run.run_id}/events?after=1`,
      headers: { 'x-admin-token': 'admin' },
    });
    const types = (events.json() as { events: { type: string }[] }).events.map((e) => e.type);
    expect(types).toEqual(['bug_report_filed']);
  });

  it('keeps every plan revision and builds the end-of-run report', async () => {
    const run = await startRun();
    const empty = await api().inject({ method: 'GET', url: '/v1/plan', headers: run.as('c01') });
    expect(empty.json()).toEqual({ plan: null });
    const bad = await api().inject({
      method: 'PUT',
      url: '/v1/plan',
      headers: run.as('c01'),
      payload: { early: 'x' },
    });
    expect(bad.json()).toMatchObject({ code: 'INVALID_ACTION' });
    const plan = {
      early: 'mine and sell ore',
      mid: 'find a smelter',
      late: 'hoard',
      now: 'mining',
      thoughts: 'quiet so far',
    };
    await api().inject({ method: 'PUT', url: '/v1/plan', headers: run.as('c01'), payload: plan });
    await api().inject({
      method: 'PUT',
      url: '/v1/plan',
      headers: run.as('c01'),
      payload: { ...plan, thoughts: 'nobody is buying' },
    });
    const latest = await api().inject({ method: 'GET', url: '/v1/plan', headers: run.as('c01') });
    expect(latest.json()).toEqual({ plan: { ...plan, thoughts: 'nobody is buying' } });
    const history = await api().inject({
      method: 'GET',
      url: `/admin/runs/${run.run_id}/plans/c01`,
      headers: { 'x-admin-token': 'admin' },
    });
    expect(
      (
        history.json() as { plans: { turn: number; round: number; plan: { thoughts: string } }[] }
      ).plans.map((p) => [p.turn, p.round, p.plan.thoughts]),
    ).toEqual([
      [1, 1, 'quiet so far'],
      [1, 1, 'nobody is buying'],
    ]);
    await api().inject({
      method: 'POST',
      url: '/v1/bug_report',
      headers: run.as('c01'),
      payload: { text: 'where do I sell ore' },
    });
    const report = await api().inject({
      method: 'GET',
      url: `/admin/runs/${run.run_id}/report`,
      headers: { 'x-admin-token': 'admin' },
    });
    expect(report.json()).toMatchObject({
      experiment_id: 'api-test',
      turn: 1,
      companies: [
        {
          id: 'c01',
          plan: { ...plan, thoughts: 'nobody is buying' },
          plan_revisions: 2,
          bug_reports: [{ turn: 1, round: 1, text: 'where do I sell ore' }],
          farming: null,
          score: 600 + 90,
        },
        { id: 'c05', plan: null, plan_revisions: 0, bug_reports: [] },
      ],
    });
  });

  it('long-polls the next round without spending budget, in a persistent run only', async () => {
    const fresh = await startRun();
    const refused = await api().inject({
      method: 'GET',
      url: '/v1/wait?turn=1&round=1&timeout_ms=0',
      headers: fresh.as('c01'),
    });
    expect(refused.statusCode).toBe(409);
    await api().close();
    const run = await startRun(new MemoryStore(), frozenClock(), {
      ...config,
      knobs: { ...config.knobs, context_persistence: 'persistent' },
    });
    const waiting = await api().inject({
      method: 'GET',
      url: '/v1/wait?turn=1&round=1&timeout_ms=10',
      headers: run.as('c01'),
    });
    expect(waiting.json()).toEqual({ status: 'waiting' });
    for (let i = 0; i < 8; i++) {
      await api().inject({
        method: 'GET',
        url: '/v1/wait?turn=1&round=1&timeout_ms=0',
        headers: run.as('c01'),
      });
    }
    const stillOpen = await api().inject({
      method: 'GET',
      url: '/v1/observation',
      headers: run.as('c01'),
    });
    expect(stillOpen.statusCode).toBe(200);
    // inject dispatches lazily, on the first then, so start the poll before advancing.
    const pending = api()
      .inject({
        method: 'GET',
        url: '/v1/wait?turn=1&round=1&timeout_ms=5000',
        headers: run.as('c01'),
      })
      .then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await run.advance();
    const next = (await pending).json() as {
      status: string;
      turn: number;
      round: number;
      observation: { round: number };
    };
    expect(next).toMatchObject({ status: 'round', turn: 1, round: 2 });
    expect(next.observation.round).toBe(2);
    const stale = await api().inject({
      method: 'GET',
      url: '/v1/wait?turn=1&round=1&timeout_ms=0',
      headers: run.as('c01'),
    });
    expect(stale.json()).toMatchObject({ status: 'round', round: 2 });
  });

  it('rolls traces up into a cost panel by company, model, and turn', async () => {
    const run = await startRun();
    const trace = (company: string, model: string, tokens_in: number) => ({
      company,
      turn: 1,
      round: 1,
      kind: 'round',
      session_id: null,
      model,
      result: {},
      tokens_in,
      tokens_out: 10,
      cost_usd: 0.5,
      duration_ms: 1000,
    });
    for (const body of [
      trace('c01', 'sonnet', 100),
      trace('c01', 'sonnet', 200),
      trace('c05', 'opus', 50),
    ]) {
      const posted = await api().inject({
        method: 'POST',
        url: `/admin/runs/${run.run_id}/traces`,
        headers: { 'x-admin-token': 'admin' },
        payload: body,
      });
      expect(posted.statusCode).toBe(201);
    }
    const cost = await api().inject({
      method: 'GET',
      url: `/admin/runs/${run.run_id}/cost`,
      headers: { 'x-admin-token': 'admin' },
    });
    expect(cost.json()).toEqual({
      by_company: {
        c01: { sessions: 2, tokens_in: 300, tokens_out: 20, cost_usd: 1, duration_ms: 2000 },
        c05: { sessions: 1, tokens_in: 50, tokens_out: 10, cost_usd: 0.5, duration_ms: 1000 },
      },
      by_model: {
        sonnet: { sessions: 2, tokens_in: 300, tokens_out: 20, cost_usd: 1, duration_ms: 2000 },
        opus: { sessions: 1, tokens_in: 50, tokens_out: 10, cost_usd: 0.5, duration_ms: 1000 },
      },
      by_turn: {
        '1': { sessions: 3, tokens_in: 350, tokens_out: 30, cost_usd: 1.5, duration_ms: 3000 },
      },
    });
  });

  it('pauses the clock and resumes, and reloads live runs from the store on restart', async () => {
    const store = new MemoryStore();
    const run = await startRun(store);
    await api().inject({
      method: 'POST',
      url: `/admin/runs/${run.run_id}/pause`,
      headers: { 'x-admin-token': 'admin' },
      payload: { reason: 'rate_limit' },
    });
    const paused = await api().inject({
      method: 'GET',
      url: '/v1/observation',
      headers: run.as('c01'),
    });
    expect(paused.json()).toMatchObject({ code: 'ROUND_CLOSED' });
    await api().inject({
      method: 'POST',
      url: `/admin/runs/${run.run_id}/resume`,
      headers: { 'x-admin-token': 'admin' },
    });
    await api().inject({
      method: 'POST',
      url: '/v1/actions',
      headers: run.as('c01'),
      payload: { actions: [{ type: 'scrap', good: 'ore', qty: 2 }] },
    });

    await app?.close();
    app = await buildServer({ store, adminToken: 'admin', docsDir, clock: frozenClock() });
    const seen = await app.inject({
      method: 'GET',
      url: '/v1/observation',
      headers: run.as('c01'),
    });
    expect(seen.json()).toMatchObject({
      turn: 1,
      round: 1,
      you: { pending_orders: { scrap: { ore: 2 } } },
    });
    const events = await store.events(run.run_id as never);
    expect(events.map((e) => e.type)).toEqual([
      'run_started',
      'round_opened',
      'run_paused',
      'run_resumed',
      'action_submitted',
    ]);
  });
});
