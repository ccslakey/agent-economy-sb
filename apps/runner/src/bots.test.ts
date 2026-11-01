import { fold } from '@agent-economy/engine';
import { describe, expect, it } from 'vitest';
import { byStrategy, playBots, roster, summarize } from './play.ts';

// The M3 acceptance criteria from the spec, run over a handful of seeds. These are the checks the
// tuning loop plays against, so a parameter change that breaks one fails here.

const fixed = (last_turn: number) => ({
  knobs: { horizon: { kind: 'fixed' as const, last_turn } },
});

/** One of each special strategy in a chain of honest traders. */
const mixed = (seed: number) =>
  roster(
    (role, slot) => {
      if (role === 'smelter' && slot === 1) return 'defector';
      if (role === 'miner' && slot === 1) return 'greedy_producer';
      if (role === 'mill' && slot === 1) return 'passive';
      if (role === 'logger' && slot === 1) return 'random';
      return 'honest_trader';
    },
    fixed(40),
    seed,
  );

const seeds = [1, 2, 3, 4, 5];

describe('determinism', () => {
  it('plays the same log twice for the same config and replays to the same state', () => {
    const a = playBots(mixed(1));
    const b = playBots(mixed(1));
    expect(JSON.stringify(a.log)).toBe(JSON.stringify(b.log));
    expect(fold(a.started, a.log.slice(1))).toEqual(a.state);
    expect(a.state.turn).toBe(40);
    expect(a.log.length).toBeGreaterThan(1000);
  });
  it('differs across seeds', () => {
    expect(JSON.stringify(playBots(mixed(1)).log)).not.toBe(JSON.stringify(playBots(mixed(2)).log));
  });
});

describe('M3 criteria', () => {
  const summaries = seeds.map((seed) => summarize(playBots(mixed(seed))));
  const stats = byStrategy(summaries);
  const of = (strategy: string) => stats.find((s) => s.strategy === strategy);

  it('honest traders trade: most complete contracts and survive', () => {
    const honest = summaries.flatMap((s) =>
      s.companies.filter((c) => c.strategy === 'honest_trader'),
    );
    expect(honest.filter((c) => c.completed > 0).length / honest.length).toBeGreaterThan(0.8);
    expect(
      (of('honest_trader')?.survived ?? 0) / (of('honest_trader')?.n ?? 1),
    ).toBeGreaterThanOrEqual(0.9);
  });
  it('a passive company goes bankrupt before the minimum game length', () => {
    for (const s of summaries) {
      const passive = s.companies.find((c) => c.strategy === 'passive');
      expect(passive?.bankrupt_turn).not.toBeNull();
      expect(passive?.bankrupt_turn ?? 99).toBeLessThan(30);
    }
  });
  it('the defector is bankrupt or cut off by the late game in most runs', () => {
    const defectors = summaries.map((s) => s.companies.find((c) => c.strategy === 'defector'));
    const isolated = defectors.filter(
      (d) =>
        d !== undefined &&
        ((d.bankrupt_turn !== null && d.bankrupt_turn <= 22) || d.late_counterparties === 0),
    );
    expect(isolated.length / defectors.length).toBeGreaterThanOrEqual(0.6);
  });
  it('cooperation beats isolation and defection on average', () => {
    expect(of('honest_trader')?.mean_score ?? 0).toBeGreaterThan(
      of('greedy_producer')?.mean_score ?? 0,
    );
    expect(of('honest_trader')?.mean_score ?? 0).toBeGreaterThan(of('defector')?.mean_score ?? 0);
  });
});
