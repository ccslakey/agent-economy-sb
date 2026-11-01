import { FINAL_GOODS, GOODS, type RunState } from '@agent-economy/schema';
import { useMemo } from 'react';
import { type Log, worldRows } from '../derive.ts';
import { LineChart } from './Chart.tsx';
import { fmt } from './ui.tsx';

export function Prices({ log, turn }: { log: Log; turn: number }) {
  const rows = useMemo(() => worldRows(log), [log]);
  return (
    <section className="card side">
      <h2>NPC clearing prices</h2>
      <LineChart
        title=""
        x={rows.map((r) => r.turn)}
        marker={turn}
        width={380}
        height={220}
        series={FINAL_GOODS.map((good) => ({
          label: good,
          points: rows.map((r) => r.prices[good] ?? null),
        }))}
      />
    </section>
  );
}

export function World({ log, state, turn }: { log: Log; state: RunState; turn: number }) {
  const rows = useMemo(() => worldRows(log), [log]);
  const x = rows.map((r) => r.turn);
  const at = rows.find((r) => r.turn === turn);
  const clears = state.market.clears.filter((c) => c.turn === turn);
  return (
    <>
      <section className="card">
        <h2>World</h2>
        <div className="row">
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
      </section>
      <section className="card">
        <div className="card-head">
          <h2>NPC market at turn {turn}</h2>
          <div className="muted">
            Active shocks:{' '}
            {at === undefined || at.shocks.length === 0 ? 'none' : at.shocks.join(', ')}
          </div>
        </div>
        {clears.length === 0 ? (
          <div className="muted">Nothing cleared this turn.</div>
        ) : (
          <div className="scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Good</th>
                  <th className="num">Cleared</th>
                  <th className="num">Price</th>
                  <th>Sellers</th>
                </tr>
              </thead>
              <tbody>
                {clears.map((c) => (
                  <tr key={c.good}>
                    <td>{c.good}</td>
                    <td className="num">{fmt(c.qty)}</td>
                    <td className="num">{fmt(c.price)}</td>
                    <td>
                      {Object.entries(c.sales)
                        .map(([id, qty]) => `${id} ${qty}`)
                        .join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
