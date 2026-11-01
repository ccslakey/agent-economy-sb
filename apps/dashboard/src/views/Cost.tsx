import { useEffect, useState } from 'react';
import { type CostBucket, type Cost as CostReport, fetchCost } from '../api.ts';
import { LineChart } from './Chart.tsx';
import { cell } from './Contracts.tsx';

function Rollup({ title, rows }: { title: string; rows: Record<string, CostBucket> }) {
  const entries = Object.entries(rows).sort(([a], [b]) => (a < b ? -1 : 1));
  return (
    <>
      <h3 style={{ fontSize: 14 }}>{title}</h3>
      <table style={{ borderCollapse: 'collapse', fontSize: 13, marginBottom: 12 }}>
        <thead>
          <tr>
            {['', 'sessions', 'tokens in', 'tokens out', 'nominal $', 'mean seconds'].map((h) => (
              <th key={h} style={cell}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, b]) => (
            <tr key={key}>
              <td style={cell}>{key}</td>
              <td style={cell}>{b.sessions}</td>
              <td style={cell}>{b.tokens_in.toLocaleString()}</td>
              <td style={cell}>{b.tokens_out.toLocaleString()}</td>
              <td style={cell}>{b.cost_usd.toFixed(2)}</td>
              <td style={cell}>{(b.duration_ms / 1000 / Math.max(1, b.sessions)).toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function Cost({ token, runId }: { token: string; runId: string }) {
  const [cost, setCost] = useState<CostReport | null>(null);
  useEffect(() => {
    fetchCost(token, runId).then(setCost, () => setCost(null));
  }, [token, runId]);
  if (cost === null) return <p>No traces for this run.</p>;
  const turns = Object.keys(cost.by_turn)
    .map(Number)
    .sort((a, b) => a - b);
  const at = (turn: number) => cost.by_turn[String(turn)];
  return (
    <section>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        <LineChart
          title="Output tokens and sessions per turn"
          x={turns}
          series={[
            { label: 'tokens out', points: turns.map((t) => at(t)?.tokens_out ?? 0) },
            { label: 'sessions ×100', points: turns.map((t) => (at(t)?.sessions ?? 0) * 100) },
          ]}
        />
        <LineChart
          title="Mean seconds per session"
          x={turns}
          series={[
            {
              label: 'seconds',
              points: turns.map((t) => {
                const b = at(t);
                return b === undefined
                  ? 0
                  : Math.round(b.duration_ms / 1000 / Math.max(1, b.sessions));
              }),
            },
          ]}
        />
      </div>
      <Rollup title="By company" rows={cost.by_company} />
      <Rollup title="By model" rows={cost.by_model} />
    </section>
  );
}
