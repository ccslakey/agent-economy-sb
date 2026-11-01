import { useEffect, useState } from 'react';
import { type CostBucket, type Cost as CostReport, fetchCost } from '../api.ts';
import { LineChart } from './Chart.tsx';
import { fmt, money } from './ui.tsx';

function Rollup({ title, rows }: { title: string; rows: Record<string, CostBucket> }) {
  const entries = Object.entries(rows).sort(([a], [b]) => (a < b ? -1 : 1));
  return (
    <section className="card" style={{ flex: '1 1 480px' }}>
      <h2>{title}</h2>
      <div className="scroll">
        <table className="data">
          <thead>
            <tr>
              <th />
              <th className="num">Sessions</th>
              <th className="num">Tokens in</th>
              <th className="num">Tokens out</th>
              <th className="num">Nominal $</th>
              <th className="num">Mean seconds</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, b]) => (
              <tr key={key}>
                <td className="nowrap">{key}</td>
                <td className="num">{b.sessions}</td>
                <td className="num">{fmt(b.tokens_in)}</td>
                <td className="num">{fmt(b.tokens_out)}</td>
                <td className="num">{money(b.cost_usd)}</td>
                <td className="num">
                  {(b.duration_ms / 1000 / Math.max(1, b.sessions)).toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Cost({ token, runId }: { token: string; runId: string }) {
  const [cost, setCost] = useState<CostReport | null>(null);
  useEffect(() => {
    fetchCost(token, runId).then(setCost, () => setCost(null));
  }, [token, runId]);
  if (cost === null) {
    return (
      <section className="card">
        <h2>Agent cost</h2>
        <div className="muted">No traces for this run.</div>
      </section>
    );
  }
  const turns = Object.keys(cost.by_turn)
    .map(Number)
    .sort((a, b) => a - b);
  const at = (turn: number) => cost.by_turn[String(turn)];
  return (
    <>
      <section className="card">
        <h2>Agent cost</h2>
        <div className="row">
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
      </section>
      <div className="row">
        <Rollup title="By company" rows={cost.by_company} />
        <Rollup title="By model" rows={cost.by_model} />
      </div>
    </>
  );
}
