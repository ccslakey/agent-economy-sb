import type { CompanyId, RunState } from '@agent-economy/schema';
import { useEffect, useState } from 'react';
import { fetchNotes, fetchPlans, type PlanVersion } from '../api.ts';
import { companyRows, describe, type Log, snapshots, timeline } from '../derive.ts';
import { LineChart } from './Chart.tsx';
import { Trace } from './Trace.tsx';
import { Chip, fmt, standingChip } from './ui.tsx';

const PLAN_FIELDS = ['early', 'mid', 'late', 'now', 'thoughts'] as const;

export function Company({
  log,
  state,
  turn,
  token,
  runId,
  selected,
  onSelect,
}: {
  log: Log;
  state: RunState;
  /** The scrubber's turn. State is folded through the end of it. */
  turn: number;
  token: string;
  runId: string;
  selected: CompanyId | null;
  onSelect: (id: CompanyId) => void;
}) {
  const rows = companyRows(state);
  const id = selected ?? rows[0]?.company.id ?? null;
  const [notes, setNotes] = useState<string>('');
  const [plans, setPlans] = useState<PlanVersion[]>([]);
  useEffect(() => {
    if (id === null) return;
    fetchNotes(token, runId, id).then(setNotes, () => setNotes(''));
    fetchPlans(token, runId, id).then(setPlans, () => setPlans([]));
  }, [token, runId, id]);
  const seen = plans.filter((p) => p.turn <= turn);
  const latestPlan = seen.at(-1)?.plan ?? null;
  const history = id === null ? [] : snapshots(log, id);
  const current = id === null ? undefined : rows.find((r) => r.company.id === id);
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Companies</h2>
          <div className="muted">Click a row to open it</div>
        </div>
        <div className="scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Company</th>
                <th>Role</th>
                <th>Driver</th>
                <th className="num">Cash</th>
                <th>Inventory</th>
                <th className="num">Net worth</th>
                <th>Standing</th>
                <th className="num">Completed</th>
                <th className="num">Defaulted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.company.id}
                  className={r.company.id === id ? 'pick selected' : 'pick'}
                  onClick={() => onSelect(r.company.id)}
                >
                  <td className="nowrap">
                    <strong>{r.company.name}</strong>{' '}
                    <span className="muted mono">{r.company.id}</span>
                  </td>
                  <td>{r.company.roles.join(', ')}</td>
                  <td>{r.strategy}</td>
                  <td className="num">{fmt(r.company.cash)}</td>
                  <td className="mono">
                    {Object.entries(r.company.inventory)
                      .filter(([, qty]) => qty > 0)
                      .map(([good, qty]) => `${good} ${qty}`)
                      .join(', ')}
                  </td>
                  <td className="num">{fmt(r.score)}</td>
                  <td>
                    <Chip kind={standingChip(r.company.standing.kind)}>
                      {r.company.standing.kind}
                    </Chip>
                  </td>
                  <td className="num">{r.reputation.completed}</td>
                  <td
                    className="num"
                    style={{ color: r.reputation.defaulted > 0 ? 'var(--red)' : undefined }}
                  >
                    {r.reputation.defaulted}
                    {r.reputation.defaulted > 0 && (
                      <span className="muted"> ({fmt(r.reputation.value_defaulted)})</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {id !== null && current !== undefined && (
        <>
          <section className="card">
            <div className="card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h1>{current.company.name}</h1>
                <Chip kind={standingChip(current.company.standing.kind)}>
                  {current.company.standing.kind}
                </Chip>
              </div>
              <div className="muted">
                {current.company.roles.join(', ')} · {current.strategy} · {current.company.id}
              </div>
            </div>
            <div className="kpis">
              <div className="kpi">
                <div className="muted">Net worth</div>
                <div className="value">{fmt(current.score)}</div>
              </div>
              <div className="kpi">
                <div className="muted">Cash</div>
                <div className="value">{fmt(current.company.cash)}</div>
              </div>
              <div className="kpi">
                <div className="muted">Completed</div>
                <div className="value">{current.reputation.completed}</div>
              </div>
              <div className="kpi">
                <div className="muted">Defaulted</div>
                <div
                  className="value"
                  style={{ color: current.reputation.defaulted > 0 ? 'var(--red)' : undefined }}
                >
                  {current.reputation.defaulted}
                </div>
                <div className="muted">{fmt(current.reputation.value_defaulted)} in value</div>
              </div>
            </div>
          </section>

          <div className="row">
            <section className="card grow">
              <div className="card-head">
                <h2>Plan as of turn {turn}</h2>
                <div className="muted">{seen.length} revisions so far</div>
              </div>
              {latestPlan === null ? (
                <div className="muted">No plan filed yet.</div>
              ) : (
                <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {PLAN_FIELDS.map((field) => (
                    <div key={field}>
                      <dt className="muted" style={{ fontWeight: 500 }}>
                        {field}
                      </dt>
                      <dd style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13 }}>
                        {latestPlan[field]}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {plans.length > 0 && (
                <details>
                  <summary>Thoughts over time</summary>
                  <ul style={{ fontSize: 13, paddingLeft: 18 }}>
                    {plans.map((p) => (
                      <li key={`${p.turn}-${p.round ?? 0}-${p.plan.thoughts.length}`}>
                        <span className="mono muted">
                          t{p.turn}
                          {p.round === null ? '' : ` r${p.round}`}
                        </span>{' '}
                        {p.plan.thoughts}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
            <section className="card side">
              <h2>notes.md</h2>
              <pre className="pre">{notes || '(none)'}</pre>
            </section>
          </div>

          <div className="row">
            <Trace token={token} runId={runId} company={id} turn={turn} />
          </div>

          <section className="card">
            <h2>Cash and net worth by turn</h2>
            <LineChart
              title=""
              x={history.map((s) => s.turn)}
              marker={turn}
              width={900}
              height={260}
              series={[
                { label: 'cash', points: history.map((s) => s.cash) },
                { label: 'net worth', points: history.map((s) => s.score) },
              ]}
            />
            <details>
              <summary>Per-turn snapshots</summary>
              <table className="data">
                <tbody>
                  {history
                    .filter((s) => s.turn <= turn)
                    .map((s) => (
                      <tr key={s.turn}>
                        <td className="mono muted">t{s.turn}</td>
                        <td className="num">cash {fmt(s.cash)}</td>
                        <td className="num">net worth {fmt(s.score)}</td>
                        <td className="mono">
                          {Object.entries(s.inventory)
                            .filter(([, qty]) => qty > 0)
                            .map(([good, qty]) => `${good} ${qty}`)
                            .join(', ')}
                        </td>
                        <td>{s.standing}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </details>
          </section>

          <section className="card">
            <h2>Timeline through turn {turn}</h2>
            <div className="scroll">
              <table className="data">
                <tbody>
                  {timeline(log, state, id)
                    .filter((e) => e.turn <= turn)
                    .map((e) => (
                      <tr key={e.id}>
                        <td className="mono muted">{e.id}</td>
                        <td className="mono muted nowrap">
                          t{e.turn}
                          {e.round === null ? '' : ` r${e.round}`}
                        </td>
                        <td className="nowrap">{e.type}</td>
                        <td>{describe(e)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
