import { gini, initialState, runMetrics, scoreOf } from '@agent-economy/engine';
import { expandSweep, Sweep } from '@agent-economy/schema';
import { describe, expect, it } from 'vitest';
import { compareRuns } from './compare.ts';
import { playBots, roster } from './play.ts';

// Metrics are a fold over a bot game, checked against the engine's own state and literal values.

const config = roster(() => 'honest_trader', {
  knobs: { horizon: { kind: 'fixed', last_turn: 6 } },
});
const played = playBots(config);
const [started, ...rest] = played.log;

describe('metrics', () => {
  it('computes gini on literal distributions', () => {
    expect(gini([1, 1, 1, 1])).toBe(0);
    expect(gini([0, 0, 0, 4])).toBeCloseTo(0.75);
    expect(gini([])).toBe(0);
  });
  it('folds a run into the spec metrics', () => {
    if (started?.type !== 'run_started') throw new Error('no log');
    const m = runMetrics(started, rest);
    expect(m.turns).toBe(6);
    expect(m.companies).toBe(12);
    expect(m.contracts.proposed).toBe(Object.keys(played.state.contracts).length);
    expect(m.contracts.completed).toBeGreaterThan(0);
    expect(m.default_rate).toBe(
      m.contracts.defaulted / (m.contracts.completed + m.contracts.defaulted),
    );
    expect(m.messages.public + m.messages.dm).toBe(played.state.messages.length);
    const first = initialState(started);
    const worth = (state: typeof played.state) =>
      Object.values(state.companies).reduce((sum, c) => sum + scoreOf(state, c), 0);
    expect(m.net_worth_gained).toBe(worth(played.state) - worth(first));
    // Starting cash plus the starting inventory at half reference.
    expect(worth(first)).toBeGreaterThan(12 * 600);
    expect(m.bot_handoffs).toBe(0);
    expect(m.gini).toBeGreaterThanOrEqual(0);
    expect(m.gini).toBeLessThan(1);
  });
  it('expands a sweep into paired runs and compares them', () => {
    if (started?.type !== 'run_started') throw new Error('no log');
    const sweep = Sweep.parse({
      experiment_id: 'x',
      seeds: [1, 2],
      base: { population: config.population, knobs: { horizon: { kind: 'fixed', last_turn: 6 } } },
      variants: [
        { name: 'a' },
        {
          name: 'b',
          knobs: { enforcement: 'off' },
          limits: { max_concurrent_sessions: 12 },
          population: config.population.slice(0, 2),
        },
      ],
    });
    const runs = expandSweep(sweep);
    expect(runs[3]?.config.population).toHaveLength(2);
    expect(runs[3]?.config.limits.max_concurrent_sessions).toBe(12);
    expect(runs[0]?.config.population).toHaveLength(12);
    expect(runs.map((r) => `${r.config.experiment_id}:${r.seed}`)).toEqual([
      'x/a:1',
      'x/a:2',
      'x/b:1',
      'x/b:2',
    ]);
    expect(runs[3]?.config.knobs.enforcement).toBe('off');
    expect(runs[0]?.config.knobs.enforcement).toBe('on');
    const m = runMetrics(started, rest);
    const table = compareRuns([
      { variant: 'a', seed: 1, metrics: m },
      { variant: 'b', seed: 1, metrics: { ...m, penalties: m.penalties + 100 } },
    ]);
    expect(table).toContain('Δ b − a');
    const penalties = table.split('\n').find((l) => l.startsWith('penalties'));
    expect(penalties?.trim().endsWith('100')).toBe(true);
  });
});
