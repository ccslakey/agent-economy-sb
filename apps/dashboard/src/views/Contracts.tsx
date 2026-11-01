import { contractValue } from '@agent-economy/engine';
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

/** Accepted turn to closing turn, or the one turn a never-accepted contract has. */
const turns = (k: Contract): string => {
  const s = k.status;
  if (s.status === 'active') return `T${s.accepted_turn} →`;
  if (s.status === 'completed' || s.status === 'defaulted') {
    return `T${s.accepted_turn} → T${s.turn}`;
  }
  return `T${s.turn}`;
};

const goodsText = (k: Contract): string =>
  k.obligations
    .map((o) => (o.kind === 'goods' ? `${o.qty} ${o.good}` : `${o.amount} cash`))
    .join(' for ');

export function Contracts({ log, state, turn }: { log: Log; state: RunState; turn: number }) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all');
  const [query, setQuery] = useState('');
  const perTurn = useMemo(() => byTurn(log), [log]);
  const name = (id: string) => state.companies[id as keyof typeof state.companies]?.name ?? id;
  const q = query.trim().toLowerCase();
  const matches = (k: Contract) =>
    q === '' ||
    [k.id, k.proposer, k.counterparty, name(k.proposer), name(k.counterparty), k.terms_text]
      .join(' ')
      .toLowerCase()
      .includes(q);
  const rows = Object.values(state.contracts)
    .filter((k) => (status === 'all' || k.status.status === status) && matches(k))
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
          <div className="toolbar">
            <span className="muted">
              {rows.length} contracts as of turn {turn}
            </span>
            <label className="field">
              Search
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Company, contract id or terms"
                style={{ width: 240 }}
              />
            </label>
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
                <th>Turns</th>
                <th>Proposer</th>
                <th>Counterparty</th>
                <th>Goods</th>
                <th className="num">Value</th>
                <th>Progress</th>
                <th>Status</th>
                <th>Terms</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id}>
                  <td className="mono">{k.id}</td>
                  <td className="mono muted nowrap">{turns(k)}</td>
                  <td className="nowrap">{name(k.proposer)}</td>
                  <td className="nowrap">{name(k.counterparty)}</td>
                  <td className="nowrap">{goodsText(k)}</td>
                  <td className="num">{fmt(contractValue(state, k.obligations))}</td>
                  <td className="muted">{k.obligations.map(obligation).join('; ')}</td>
                  <td className="nowrap">
                    <Chip kind={contractChip(k.status.status)}>{k.status.status}</Chip>
                    {k.status.status === 'defaulted' && (
                      <span className="muted">
                        {' '}
                        by {k.status.by.join(', ')} · {fmt(k.status.unmet_value)} unmet
                      </span>
                    )}
                  </td>
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
