import { scoreOf } from '@agent-economy/engine';
import { playBots, roster } from '@agent-economy/runner';
import { CompanyId } from '@agent-economy/schema';
import { expect, describe as group, it } from 'vitest';
import {
  byTurn,
  companyRows,
  describe,
  lastTurn,
  leaderboard,
  leaderSince,
  messageRows,
  snapshots,
  splitLog,
  stateAt,
  timeline,
  worldRows,
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
  it('sums the world per turn: money, output, groves, prices where a good cleared', () => {
    if (log === null) throw new Error('no log');
    const rows = worldRows(log);
    expect(rows.map((r) => r.turn)).toEqual([1, 2, 3, 4]);
    const last = rows.at(-1);
    const cash = Object.values(played.state.companies).reduce((sum, c) => sum + c.cash, 0);
    expect(last?.money).toBe(cash);
    expect(last?.solvent).toBe(12);
    expect(rows[0]?.output.ore).toBeGreaterThan(0);
    expect(rows[0]?.groves).toBeGreaterThan(0);
    const cleared = played.state.market.clears.find((c) => c.turn === 4 && c.qty > 0);
    if (cleared !== undefined) expect(last?.prices[cleared.good]).toBe(cleared.price);
    expect(byTurn(log).at(-1)?.state).toEqual(played.state);
  });
  it('counts contract moves and messages per turn', () => {
    if (log === null) throw new Error('no log');
    const rows = byTurn(log);
    const proposed = rows.reduce((sum, r) => sum + r.contracts.proposed, 0);
    expect(proposed).toBe(Object.keys(played.state.contracts).length);
    const volume = messageRows(
      played.state,
      rows.map((r) => r.turn),
    );
    expect(volume.map((v) => v.turn)).toEqual([1, 2, 3, 4]);
    expect(volume.reduce((sum, v) => sum + v.public + v.dm, 0)).toBe(played.state.messages.length);
  });
  it('ranks companies by net worth with one score per turn and names the leader since', () => {
    if (log === null) throw new Error('no log');
    const board = leaderboard(log);
    expect(board.turns).toEqual([1, 2, 3, 4]);
    expect(board.series).toHaveLength(12);
    expect(board.series.every((s) => s.scores.length === 4)).toBe(true);
    const top = board.series[0];
    if (top === undefined) throw new Error('empty board');
    expect(top.scores.at(-1)).toBe(scoreOf(played.state, top.company));
    expect(top.driver).toBe('honest_trader');
    const since = leaderSince(board.turns, board.series, 4);
    expect(since).not.toBeNull();
    expect(since ?? 0).toBeLessThanOrEqual(4);
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
