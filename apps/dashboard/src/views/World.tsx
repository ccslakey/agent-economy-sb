import { FINAL_GOODS, GOODS, type RunState } from '@agent-economy/schema';
import { useMemo } from 'react';
import { type Log, worldRows } from '../derive.ts';
import { LineChart } from './Chart.tsx';
import { cell } from './Contracts.tsx';

export function World({ log, state, turn }: { log: Log; state: RunState; turn: number }) {
  const rows = useMemo(() => worldRows(log), [log]);
  const x = rows.map((r) => r.turn);
  const at = rows.find((r) => r.turn === turn);
  return (
    <section>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        <LineChart
          title="Money supply and solvent companies"
          x={x}
          marker={turn}
          series={[
            { label: 'total cash', points: rows.map((r) => r.money) },
            { label: 'solvent ×100', points: rows.map((r) => r.solvent * 100) },
          ]}
        />
        <LineChart
          title="NPC clearing prices"
          x={x}
          marker={turn}
          series={FINAL_GOODS.map((good) => ({
            label: good,
            points: rows.map((r) => r.prices[good] ?? null),
          }))}
        />
        <LineChart
          title="Output per turn"
          x={x}
          marker={turn}
          series={GOODS.map((good) => ({
            label: good,
            points: rows.map((r) => r.output[good] ?? 0),
          }))}
        />
        <LineChart
          title="Grove stock and penalties destroyed"
          x={x}
          marker={turn}
          series={[
            { label: 'timber in groves', points: rows.map((r) => r.groves) },
            { label: 'penalties', points: rows.map((r) => r.penalties) },
          ]}
        />
      </div>
      <h3 style={{ fontSize: 14 }}>Turn {turn}</h3>
      <p style={{ fontSize: 13 }}>
        Active shocks: {at === undefined || at.shocks.length === 0 ? 'none' : at.shocks.join(', ')}
      </p>
      <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {['good', 'cleared', 'price', 'sellers'].map((h) => (
              <th key={h} style={cell}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.market.clears
            .filter((c) => c.turn === turn)
            .map((c) => (
              <tr key={c.good}>
                <td style={cell}>{c.good}</td>
                <td style={cell}>{c.qty}</td>
                <td style={cell}>{c.price}</td>
                <td style={cell}>
                  {Object.entries(c.sales)
                    .map(([id, qty]) => `${id} ${qty}`)
                    .join(', ')}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}
