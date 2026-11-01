import { playBots, roster } from '@agent-economy/runner';
import { CompanyId } from '@agent-economy/schema';
import { expect, describe as group, it } from 'vitest';
import {
  companyRows,
  describe,
  lastTurn,
  snapshots,
  splitLog,
  stateAt,
  timeline,
} from './derive.ts';

// The inspector's data is a fold over the log. These checks play a short bot game and verify the
// scrubber, the per-turn snapshots, and the company timeline against the engine's own state.

const config = roster(() => 'honest_trader', {
  knobs: { horizon: { kind: 'fixed', last_turn: 4 } },
});
const played = playBots(config);
const log = splitLog(played.log);

group('derive', () => {
  it('scrubs to any turn and lands on the final state at the end', () => {
    if (log === null) throw new Error('no log');
    expect(lastTurn(log)).toBe(4);
    expect(stateAt(log, null)).toEqual(played.state);
    expect(stateAt(log, 2).turn).toBe(3);
    expect(stateAt(log, 1).turn).toBe(2);
  });
  it("snapshots one row per closed turn with the fold's cash", () => {
    if (log === null) throw new Error('no log');
    const rows = snapshots(log, CompanyId.parse('c01'));
    expect(rows.map((r) => r.turn)).toEqual([1, 2, 3, 4]);
    expect(rows.at(-1)?.cash).toBe(played.state.companies[CompanyId.parse('c01')]?.cash);
  });
  it('builds a timeline of the events a company took part in, each with a description', () => {
    if (log === null) throw new Error('no log');
    const events = timeline(log, played.state, CompanyId.parse('c05'));
    expect(events.length).toBeGreaterThan(10);
    expect(events.every((e) => describe(e).length > 0)).toBe(true);
    expect(events.some((e) => e.type === 'contract_proposed')).toBe(true);
    expect(companyRows(played.state).map((r) => r.company.id)).toHaveLength(12);
  });
});
