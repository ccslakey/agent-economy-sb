import { CompanyId, type RunState } from '@agent-economy/schema';
import { useEffect, useState } from 'react';
import { fetchNotes, fetchPlans, type PlanVersion } from '../api.ts';
import { companyRows, describe, type Log, snapshots, timeline } from '../derive.ts';
import { LineChart } from './Chart.tsx';
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
  const [plans, setPlans] = useState<PlanVersion[]>([]);
  useEffect(() => {
    if (selected === '') return;
    fetchNotes(token, runId, selected).then(setNotes, () => setNotes(''));
    fetchPlans(token, runId, selected).then(setPlans, () => setPlans([]));
  }, [token, runId, selected]);
  const latestPlan = plans.findLast((p) => p.turn <= turn)?.plan ?? null;
  const id = CompanyId.safeParse(selected);
  const history = id.success ? snapshots(log, id.data) : [];
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
          {latestPlan !== null && (
            <details open>
              <summary>
                Plan as of turn {turn} ({plans.filter((p) => p.turn <= turn).length} revisions so
                far)
              </summary>
              <dl style={{ fontSize: 13 }}>
                {(['early', 'mid', 'late', 'now', 'thoughts'] as const).map((field) => (
                  <div key={field}>
                    <dt style={{ fontWeight: 'bold' }}>{field}</dt>
                    <dd style={{ whiteSpace: 'pre-wrap' }}>{latestPlan[field]}</dd>
                  </div>
                ))}
              </dl>
              <details>
                <summary>Thoughts over time</summary>
                <ul style={{ fontSize: 13 }}>
                  {plans.map((p) => (
                    <li key={`${p.turn}-${p.round ?? 0}-${p.plan.thoughts.length}`}>
                      t{p.turn}
                      {p.round === null ? '' : ` r${p.round}`}: {p.plan.thoughts}
                    </li>
                  ))}
                </ul>
              </details>
            </details>
          )}
          <LineChart
            title="Cash and net worth by turn"
            x={history.map((s) => s.turn)}
            marker={turn}
            series={[
              { label: 'cash', points: history.map((s) => s.cash) },
              { label: 'net worth', points: history.map((s) => s.score) },
            ]}
          />
          <details>
            <summary>Cash and score by turn</summary>
            <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                {history
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
