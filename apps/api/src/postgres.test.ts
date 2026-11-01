import { randomUUID } from 'node:crypto';
import { fold, rngFor, start, step } from '@agent-economy/engine';
import { CompanyId, type Event, RunConfig, RunId } from '@agent-economy/schema';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresStore } from './postgres.ts';

// Runs only with DATABASE_URL set, so `pnpm check` stays green without a database and CI can
// opt in with a service container. Locally: DATABASE_URL=postgres:///agent_economy_test pnpm test

const url = process.env.DATABASE_URL;

describe.skipIf(url === undefined)('PostgresStore', () => {
  const store = new PostgresStore(url ?? '');
  afterAll(() => store.close());

  it('round-trips a run, its events, and notes', async () => {
    await store.migrate();
    const config = RunConfig.parse({
      seed: 11,
      experiment_id: 'pg-test',
      population: [
        {
          id: 'c01',
          name: 'Ironreach',
          role: 'miner',
          driver: { kind: 'bot', strategy: 'random' },
        },
      ],
    });
    const runId = RunId.parse(`r-${randomUUID()}`);
    await store.createRun({ id: runId, config, status: 'running', tokens: { c01: 't1' } });
    expect(await store.getRun(runId)).toEqual({
      id: runId,
      config,
      status: 'running',
      tokens: { c01: 't1' },
    });

    const started = start(config, runId);
    let state = fold(started, []);
    const log: Event[] = [started];
    const play = (input: Parameters<typeof step>[1]) => {
      const events = step(state, input, rngFor(config.seed, state.turn));
      log.push(...events);
      state = fold(started, log.slice(1));
    };
    play({
      kind: 'submit',
      company: CompanyId.parse('c01'),
      actions: [{ type: 'extract', from: { kind: 'ore_pit' }, qty: 12 }],
    });
    play({ kind: 'resolve_round' });
    play({ kind: 'resolve_round' });
    play({ kind: 'resolve_round' });
    play({ kind: 'operations' });
    await store.append(runId, log);

    const back = await store.events(runId);
    expect(back).toEqual(log);
    expect(fold(started, back.slice(1))).toEqual(state);
    expect(await store.events(runId, log.length - 2)).toHaveLength(1);
    await expect(store.append(runId, [log[1] as Event])).rejects.toThrow();

    expect(await store.getNotes(runId, CompanyId.parse('c01'))).toBe('');
    await store.putNotes(runId, CompanyId.parse('c01'), 'first');
    await store.putNotes(runId, CompanyId.parse('c01'), 'second');
    expect(await store.getNotes(runId, CompanyId.parse('c01'))).toBe('second');

    const trace = {
      id: randomUUID(),
      run_id: runId,
      company: CompanyId.parse('c01'),
      turn: 1,
      round: 2,
      kind: 'round' as const,
      session_id: 's1',
      model: 'sonnet',
      result: { result: 'submitted', num_turns: 4 },
      tokens_in: 1200,
      tokens_out: 80,
      cost_usd: 0.03,
      duration_ms: 900,
    };
    await store.putTrace(trace);
    expect(await store.listTraces(runId, CompanyId.parse('c01'))).toEqual([trace]);
    expect(await store.listTraces(runId, CompanyId.parse('c02'))).toEqual([]);

    const plan = { early: 'a', mid: 'b', late: 'c', now: 'd', thoughts: 'e' };
    expect(await store.getPlan(runId, CompanyId.parse('c01'))).toBeNull();
    await store.putPlan({
      run_id: runId,
      company: CompanyId.parse('c01'),
      turn: 1,
      round: 1,
      plan,
    });
    await store.putPlan({
      run_id: runId,
      company: CompanyId.parse('c01'),
      turn: 2,
      round: 1,
      plan: { ...plan, thoughts: 'f' },
    });
    expect(await store.getPlan(runId, CompanyId.parse('c01'))).toEqual({ ...plan, thoughts: 'f' });
    expect((await store.listPlans(runId, CompanyId.parse('c01'))).map((p) => p.turn)).toEqual([
      1, 2,
    ]);

    const stale = RunId.parse(`r-${randomUUID()}`);
    await store.createRun({ id: stale, config, status: 'ended', tokens: {} });
    await store.rawUpdateConfig(stale, {
      ...config,
      knobs: { ...config.knobs, enforcement: 'escrow_available' },
    });
    expect((await store.listRuns()).some((r) => r.id === stale)).toBe(false);
    expect(store.skippedRuns).toContain(stale);

    await store.setRunStatus(runId, 'ended');
    expect((await store.listRuns()).find((r) => r.id === runId)?.status).toBe('ended');
  });
});
