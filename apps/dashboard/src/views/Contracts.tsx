import type { Contract, RunState } from '@agent-economy/schema';
import { useState } from 'react';

const STATUSES = [
  'all',
  'proposed',
  'active',
  'completed',
  'defaulted',
  'cured',
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

export function Contracts({ state }: { state: RunState }) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all');
  const rows = Object.values(state.contracts)
    .filter((k) => status === 'all' || k.status.status === status)
    .sort((a, b) => contractNumber(a.id) - contractNumber(b.id));
  return (
    <section>
      <p>
        <label>
          Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>{' '}
        {rows.length} contracts
      </p>
      <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {[
              'id',
              'proposer',
              'counterparty',
              'escrow',
              'obligations',
              'status',
              'turn',
              'terms',
            ].map((h) => (
              <th key={h} style={cell}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((k) => (
            <tr key={k.id}>
              <td style={cell}>{k.id}</td>
              <td style={cell}>{k.proposer}</td>
              <td style={cell}>{k.counterparty}</td>
              <td style={cell}>{k.escrow ? 'yes' : ''}</td>
              <td style={cell}>{k.obligations.map(obligation).join('; ')}</td>
              <td style={cell}>
                {k.status.status}
                {k.status.status === 'defaulted' &&
                  ` by ${k.status.by.join(', ')} (${k.status.unmet_value})`}
                {k.status.status === 'cured' && ` (${k.status.cured_value})`}
              </td>
              <td style={cell}>{statusTurn(k)}</td>
              <td style={cell}>{k.terms_text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export const cell = { border: '1px solid #ccc', padding: '2px 6px', textAlign: 'left' } as const;
