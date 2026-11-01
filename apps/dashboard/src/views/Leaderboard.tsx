import { useMemo } from 'react';
import { type Log, leaderboard, leaderSince } from '../derive.ts';
import { LineChart } from './Chart.tsx';
import { Chip, delta, fmt, standingChip } from './ui.tsx';

export function Leaderboard({ log, turn }: { log: Log; turn: number }) {
  const board = useMemo(() => leaderboard(log), [log]);
  const index = board.turns.indexOf(turn);
  const ranked = [...board.series]
    .map((s) => ({ ...s, score: s.scores[index] ?? 0, before: s.scores[index - 1] ?? null }))
    .sort((a, b) => b.score - a.score);
  const since = leaderSince(board.turns, board.series, turn);
  const leader = ranked[0];
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Net worth by company</h2>
          <div className="muted">
            Standings after turn {turn}
            {since !== null &&
              leader !== undefined &&
              ` · ${leader.company.name} has led since turn ${since}`}
          </div>
        </div>
        <LineChart
          title=""
          x={board.turns}
          marker={turn}
          width={900}
          height={300}
          series={board.series.map((s) => ({
            label: `${s.company.name} (${s.company.roles.join('+')}, ${s.driver})`,
            points: s.scores,
          }))}
        />
      </section>
      <section className="card">
        <h2>Leaderboard</h2>
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
    </>
  );
}
