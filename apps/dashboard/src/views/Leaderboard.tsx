import { useMemo } from 'react';
import { type Log, leaderboard, leaderSince } from '../derive.ts';
import { LineChart } from './Chart.tsx';
import { cell } from './Contracts.tsx';

export function Leaderboard({ log, turn }: { log: Log; turn: number }) {
  const board = useMemo(() => leaderboard(log), [log]);
  const index = board.turns.indexOf(turn);
  const ranked = [...board.series]
    .map((s) => ({ ...s, score: s.scores[index] ?? 0, before: s.scores[index - 1] ?? null }))
    .sort((a, b) => b.score - a.score);
  const since = leaderSince(board.turns, board.series, turn);
  return (
    <section>
      <LineChart
        title="Net worth by company"
        x={board.turns}
        marker={turn}
        width={900}
        height={300}
        series={board.series.map((s) => ({
          label: `${s.company.id} ${s.company.name} (${s.company.roles.join('+')}, ${s.driver})`,
          points: s.scores,
        }))}
      />
      <p style={{ fontSize: 13 }}>
        Standings after turn {turn}.{' '}
        {since !== null &&
          ranked[0] !== undefined &&
          `${ranked[0].company.id} has led since turn ${since}.`}
      </p>
      <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {['rank', 'id', 'name', 'roles', 'driver', 'net worth', 'change', 'standing'].map(
              (h) => (
                <th key={h} style={cell}>
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {ranked.map((s, rank) => (
            <tr key={s.company.id}>
              <td style={cell}>{rank + 1}</td>
              <td style={cell}>{s.company.id}</td>
              <td style={cell}>{s.company.name}</td>
              <td style={cell}>{s.company.roles.join(', ')}</td>
              <td style={cell}>{s.driver}</td>
              <td style={cell}>{s.score}</td>
              <td style={cell}>{s.before === null ? '-' : s.score - s.before}</td>
              <td style={cell}>{s.company.standing.kind}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
