import { moments } from '@agent-economy/engine';
import { RunId } from '@agent-economy/schema';
import { describe, expect, it } from 'vitest';
import { playBots, roster } from './play.ts';

// Moments are rules over the log. A bot game with one defector gives default waves and a worst
// defaulter; every moment must cite events that exist and sit inside its own turn range.

const run = RunId.parse('r-moments');
const config = roster(
  (role, slot) => (role === 'smelter' && slot === 1 ? 'defector' : 'honest_trader'),
  { knobs: { horizon: { kind: 'fixed', last_turn: 6 } } },
);
const [started, ...rest] = playBots(config, run).log;
if (started?.type !== 'run_started') throw new Error('no run_started');

describe('moments', () => {
  const found = moments(started, rest);

  it('finds the defector and how the run ended', () => {
    const kinds = found.map((m) => m.kind);
    expect(kinds).toContain('worst_defaulter');
    expect(kinds).toContain('run_end');
    const worst = found.find((m) => m.kind === 'worst_defaulter');
    expect(worst?.text).toContain('Kilnmark');
    expect(worst?.text).toContain('the most of any company');
  });

  it("cites only real events inside each moment's turn range, most important first", () => {
    const byId = new Map(rest.map((e) => [e.id, e]));
    expect(found.length).toBeGreaterThan(0);
    for (const m of found) {
      expect(m.events.length).toBeGreaterThan(0);
      for (const id of m.events) {
        const e = byId.get(id);
        expect(e).toBeDefined();
        expect(e?.turn).toBeGreaterThanOrEqual(m.from_turn);
        expect(e?.turn).toBeLessThanOrEqual(m.to_turn);
      }
    }
    const weights = found.map((m) => m.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it('is empty before anything happened', () => {
    expect(moments(started, [])).toEqual([]);
  });
});
