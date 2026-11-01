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

    await store.setRunStatus(runId, 'ended');
    expect((await store.listRuns()).find((r) => r.id === runId)?.status).toBe('ended');
  });
});
