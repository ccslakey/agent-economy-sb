import type { Contract, RunState } from '@agent-economy/schema';
import { useMemo, useState } from 'react';
import { byTurn, CONTRACT_MOVES, type Log } from '../derive.ts';
import { LineChart } from './Chart.tsx';
import { Chip, contractChip, fmt } from './ui.tsx';

const STATUSES = [
  'all',
  'proposed',
  'active',
  'completed',
  'defaulted',
  'rejected',
  'withdrawn',
  'expired',
] as const;

const obligation = (o: Contract['obligations'][number]) =>
  `${o.by} ${o.kind === 'goods' ? `${o.met}/${o.qty} ${o.good}` : `${o.met}/${o.amount} cash`} by t${o.due_turn}`;

/** Contract ids are k1, k2, ... so a text sort would put k10 before k2. */
const contractNumber = (id: string): number => Number(id.slice(1));

const statusTurn = (k: Contract): number =>
  k.status.status === 'active' ? k.status.accepted_turn : k.status.turn;

export function Contracts({ log, state, turn }: { log: Log; state: RunState; turn: number }) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all');
  const perTurn = useMemo(() => byTurn(log), [log]);
  const rows = Object.values(state.contracts)
    .filter((k) => status === 'all' || k.status.status === status)
    .sort((a, b) => contractNumber(a.id) - contractNumber(b.id));
  return (
    <>
      <section className="card">
        <h2>Contract activity</h2>
        <div className="row">
          <LineChart
            title="Contracts per turn"
            x={perTurn.map((r) => r.turn)}
            marker={turn}
            series={CONTRACT_MOVES.map((move) => ({
              label: move,
              points: perTurn.map((r) => r.contracts[move]),
            }))}
          />
          <LineChart
            title="Cash destroyed by penalties"
            x={perTurn.map((r) => r.turn)}
            marker={turn}
            series={[{ label: 'penalties', points: perTurn.map((r) => r.penalties) }]}
          />
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Contract ledger</h2>
          <div className="muted">
            {rows.length} contracts as of turn {turn}
          </div>
        </div>
        <fieldset className="pills" aria-label="Contract status filter">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className="pill"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
            >
              {s}
            </button>
          ))}
        </fieldset>
        <div className="scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Proposer</th>
                <th>Counterparty</th>
                <th>Obligations</th>
                <th>Status</th>
                <th className="num">Turn</th>
                <th>Terms</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id}>
                  <td className="mono">{k.id}</td>
                  <td className="nowrap">{k.proposer}</td>
                  <td className="nowrap">{k.counterparty}</td>
                  <td>{k.obligations.map(obligation).join('; ')}</td>
                  <td className="nowrap">
                    <Chip kind={contractChip(k.status.status)}>{k.status.status}</Chip>
                    {k.status.status === 'defaulted' && (
                      <span className="muted">
                        {' '}
                        by {k.status.by.join(', ')} · {fmt(k.status.unmet_value)} unmet
                      </span>
                    )}
                  </td>
                  <td className="num">{statusTurn(k)}</td>
                  <td>{k.terms_text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
