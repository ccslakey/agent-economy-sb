import { CompanyId, type RunState } from '@agent-economy/schema';
import { useEffect, useState } from 'react';
import { fetchNotes } from '../api.ts';
import { companyRows, describe, type Log, snapshots, timeline } from '../derive.ts';
import { cell } from './Contracts.tsx';

export function Company({
  log,
  state,
  turn,
  token,
  runId,
}: {
  log: Log;
  state: RunState;
  /** The scrubber's turn. State is folded through the end of it. */
  turn: number;
  token: string;
  runId: string;
}) {
  const rows = companyRows(state);
  const [selected, setSelected] = useState<string>(rows[0]?.company.id ?? '');
  const [notes, setNotes] = useState<string>('');
  useEffect(() => {
    if (selected === '') return;
    fetchNotes(token, runId, selected).then(setNotes, () => setNotes(''));
  }, [token, runId, selected]);
  const id = CompanyId.safeParse(selected);
  const current = id.success ? rows.find((r) => r.company.id === id.data) : undefined;
  return (
    <section>
      <table style={{ borderCollapse: 'collapse', fontSize: 13, marginBottom: 12 }}>
        <thead>
          <tr>
            {[
              'id',
              'name',
              'roles',
              'driver',
              'cash',
              'inventory',
              'score',
              'standing',
              'completed',
              'defaulted',
              'cured',
            ].map((h) => (
              <th key={h} style={cell}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.company.id}
              onClick={() => setSelected(r.company.id)}
              style={{
                cursor: 'pointer',
                background: r.company.id === selected ? '#eef' : undefined,
              }}
            >
              <td style={cell}>{r.company.id}</td>
              <td style={cell}>{r.company.name}</td>
              <td style={cell}>{r.company.roles.join(', ')}</td>
              <td style={cell}>{r.strategy}</td>
              <td style={cell}>{r.company.cash}</td>
              <td style={cell}>{JSON.stringify(r.company.inventory)}</td>
              <td style={cell}>{r.score}</td>
              <td style={cell}>{r.company.standing.kind}</td>
              <td style={cell}>{r.reputation.completed}</td>
              <td style={cell}>
                {r.reputation.defaulted} ({r.reputation.value_defaulted})
              </td>
              <td style={cell}>
                {r.reputation.cured} ({r.reputation.value_cured})
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {id.success && current !== undefined && (
        <>
          <h2 style={{ fontSize: 16 }}>
            {current.company.name} ({current.company.id})
          </h2>
          <p>
            <strong>Notes.</strong>{' '}
            <span style={{ whiteSpace: 'pre-wrap' }}>{notes || '(none)'}</span>
          </p>
          <details>
            <summary>Cash and score by turn</summary>
            <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                {snapshots(log, id.data)
                  .filter((s) => s.turn <= turn)
                  .map((s) => (
                    <tr key={s.turn}>
                      <td style={cell}>t{s.turn}</td>
                      <td style={cell}>cash {s.cash}</td>
                      <td style={cell}>score {s.score}</td>
                      <td style={cell}>{JSON.stringify(s.inventory)}</td>
                      <td style={cell}>{s.standing}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
          <h3 style={{ fontSize: 14 }}>Timeline through turn {turn}</h3>
          <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {timeline(log, state, id.data)
                .filter((e) => e.turn <= turn)
                .map((e) => (
                  <tr key={e.id}>
                    <td style={cell}>{e.id}</td>
                    <td style={cell}>
                      t{e.turn}
                      {e.round === null ? '' : ` r${e.round}`}
                    </td>
                    <td style={cell}>{e.type}</td>
                    <td style={cell}>{describe(e)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
