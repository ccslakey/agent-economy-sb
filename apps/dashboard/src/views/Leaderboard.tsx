import { reputationOf } from '@agent-economy/engine';
import { useMemo } from 'react';
import { type Log, leaderboard, leaderSince, stateAt } from '../derive.ts';
import { LineChart, type Series } from './Chart.tsx';
import { Chip, delta, fmt, standingChip } from './ui.tsx';

const HIGHLIGHTS = ['#1D4ED8', '#0F766E', '#7C3AED'];
const DEFAULTER = '#C2410C';

/** Net worth over the game: the top three and the largest defaulter in color, the rest grey. */
export function NetWorth({ log, turn }: { log: Log; turn: number }) {
  const board = useMemo(() => leaderboard(log), [log]);
  const series = useMemo((): Series[] => {
    const final = stateAt(log, null);
    const defaulter = board.series
      .map((s) => ({ id: s.company.id, value: reputationOf(final, s.company).value_defaulted }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value)[0];
    return board.series.map((s, rank) => {
      const label = s.company.name;
      const color = HIGHLIGHTS[rank];
      if (color !== undefined) return { label, points: s.scores, color };
      if (defaulter !== undefined && defaulter.id === s.company.id) {
        return { label: `${label} (largest defaulter)`, points: s.scores, color: DEFAULTER };
      }
      return { label, points: s.scores, muted: true };
    });
  }, [log, board]);
  const since = leaderSince(board.turns, board.series, turn);
  const index = board.turns.indexOf(turn);
  const leader = board.series.reduce<(typeof board.series)[number] | undefined>(
    (best, s) =>
      best === undefined || (s.scores[index] ?? 0) > (best.scores[index] ?? 0) ? s : best,
    undefined,
  );
  return (
    <section className="card grow">
      <div className="card-head">
        <h2>Net worth by company</h2>
        <div className="muted">
          Top three and the largest defaulter highlighted · others in grey
          {since !== null &&
            leader !== undefined &&
            ` · ${leader.company.name} has led since turn ${since}`}
        </div>
      </div>
      <LineChart title="" x={board.turns} marker={turn} width={800} height={330} series={series} />
    </section>
  );
}

export function Leaderboard({ log, turn }: { log: Log; turn: number }) {
  const board = useMemo(() => leaderboard(log), [log]);
  const index = board.turns.indexOf(turn);
  const ranked = [...board.series]
    .map((s) => ({ ...s, score: s.scores[index] ?? 0, before: s.scores[index - 1] ?? null }))
    .sort((a, b) => b.score - a.score);
  return (
    <section className="card grow">
      <div className="card-head">
        <h2>Leaderboard</h2>
        <div className="muted">Standings after turn {turn}</div>
      </div>
      <div className="scroll">
        <table className="data">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Company</th>
              <th>Role</th>
              <th>Driver</th>
              <th className="num">Net worth</th>
              <th className="num">Change</th>
              <th>Standing</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((s, rank) => (
              <tr key={s.company.id}>
                <td className="num muted">{rank + 1}</td>
                <td className="nowrap">
                  <strong>{s.company.name}</strong>{' '}
                  <span className="muted mono">{s.company.id}</span>
                </td>
                <td>{s.company.roles.join(', ')}</td>
                <td>{s.driver}</td>
                <td className="num">{fmt(s.score)}</td>
                <td
                  className="num"
                  style={{
                    color:
                      s.before === null || s.score === s.before
                        ? undefined
                        : s.score > s.before
                          ? 'var(--teal)'
                          : 'var(--red)',
                  }}
                >
                  {s.before === null ? '-' : delta(s.score - s.before)}
                </td>
                <td>
                  <Chip kind={standingChip(s.company.standing.kind)}>
                    {s.company.standing.kind}
                  </Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
