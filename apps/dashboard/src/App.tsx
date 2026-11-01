import type { CompanyId, Event, RunState } from '@agent-economy/schema';
import { useEffect, useMemo, useState } from 'react';
import {
  exportEvents,
  fetchEvents,
  listRuns,
  type RunListing,
  savedToken,
  saveToken,
} from './api.ts';
import { byTurn, type EdgeFilter, type Log, lastTurn, splitLog, stateAt } from './derive.ts';
import { Company } from './views/Company.tsx';
import { Compare } from './views/Compare.tsx';
import { Contracts } from './views/Contracts.tsx';
import { Messages } from './views/Messages.tsx';
import { Network, NetworkFilters, SelectedCompany } from './views/Network.tsx';
import { Overview } from './views/Overview.tsx';

const PAGES = [
  { id: 'overview', label: 'Overview' },
  { id: 'network', label: 'Trade network' },
  { id: 'companies', label: 'Companies' },
  { id: 'compare', label: 'Compare runs' },
] as const;
type Page = (typeof PAGES)[number]['id'];

const runLabel = (r: RunListing) =>
  `${r.experiment_id} · seed ${r.seed} · ${r.status}${r.turn === null ? '' : ` · turn ${r.turn}`}`;

const ENDINGS = {
  horizon_roll: 'ended by horizon roll',
  fixed_last_turn: 'ended at the fixed last turn',
  aborted: 'aborted',
} as const;

function Logo() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="#93C5FD"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <circle cx="5" cy="5" r="2.5" />
      <circle cx="15" cy="5" r="2.5" />
      <circle cx="10" cy="15" r="2.5" />
      <path d="M7 6.5 L8.8 12.8 M13 6.5 L11.2 12.8 M7.5 5 H12.5" />
    </svg>
  );
}

export function App() {
  const [token, setToken] = useState(savedToken);
  const [runs, setRuns] = useState<RunListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [turn, setTurn] = useState<number | null>(null);
  const [page, setPage] = useState<Page>('compare');
  const [company, setCompany] = useState<CompanyId | null>(null);
  const [filter, setFilter] = useState<EdgeFilter>({ status: 'all', good: 'all' });

  useEffect(() => {
    if (token === '') return;
    saveToken(token);
    listRuns(token).then(
      (list) => {
        setRuns(list);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [token]);

  useEffect(() => {
    if (runId === null || token === '') return;
    setLog(null);
    fetchEvents(token, runId).then(
      (events: Event[]) => {
        const split = splitLog(events);
        setLog(split);
        setTurn(split === null ? null : lastTurn(split));
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [runId, token]);

  const state: RunState | null = useMemo(
    () => (log === null ? null : stateAt(log, turn)),
    [log, turn],
  );
  const turns = useMemo(() => (log === null ? [] : byTurn(log).map((r) => r.turn)), [log]);
  const run = runs?.find((r) => r.id === runId);
  const ended = log?.rest.find((e) => e.type === 'run_ended');

  const openRun = (id: string | null) => {
    setRunId(id);
    setCompany(null);
    setPage(id === null ? 'compare' : 'overview');
  };
  const openCompany = (id: CompanyId) => {
    setCompany(id);
    setPage('companies');
  };
  const ready = runId !== null && log !== null && state !== null && turn !== null;
  const shown: Page = ready ? page : 'compare';

  return (
    <>
      <header className="header">
        <div className="container">
          <div className="brand">
            <Logo />
            Agent Economy · Admin
          </div>
          <nav className="nav" aria-label="Dashboard sections">
            {PAGES.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-current={shown === p.id ? 'page' : undefined}
                disabled={!ready && p.id !== 'compare'}
                onClick={() => setPage(p.id)}
              >
                {p.label}
              </button>
            ))}
          </nav>
          <div className="header-right">
            {runs === null ? (
              <label className="field">
                Admin token
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  size={32}
                  type="password"
                />
              </label>
            ) : (
              <label className="field">
                Run
                <select value={runId ?? ''} onChange={(e) => openRun(e.target.value || null)}>
                  <option value="">All runs</option>
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {runLabel(r)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
      </header>

      {ready && run !== undefined && (
        <div className="runbar">
          <div className="container">
            <div>
              <div className="muted">
                Seed {run.seed} · {Object.keys(state.companies).length} companies ·{' '}
                {run.population.models.length} models ·{' '}
                {ended === undefined ? run.status : ENDINGS[ended.payload.reason]}
              </div>
              <div className="run-title">{run.experiment_id}</div>
            </div>
            <div className="turnctl">
              <label htmlFor="turn" className="muted">
                Turn
              </label>
              <input
                id="turn"
                type="range"
                min={1}
                max={lastTurn(log)}
                value={turn}
                onChange={(e) => setTurn(Number(e.target.value))}
              />
              <div className="mono">
                {turn} / {lastTurn(log)}
              </div>
              <span className="muted">phase {state.phase.kind}</span>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => exportEvents(token, runId).catch((e: Error) => setError(e.message))}
            >
              Export events
            </button>
          </div>
        </div>
      )}

      <main className="container main">
        {error !== null && <p className="error">{error}</p>}
        {runs === null && error === null && (
          <p className="muted">Enter the admin token to load runs.</p>
        )}
        {runs !== null && runId !== null && log === null && <p className="muted">Loading run…</p>}
        {runs !== null && shown === 'compare' && (
          <Compare runs={runs} token={token} onSelect={openRun} />
        )}
        {ready && run !== undefined && shown === 'overview' && (
          <Overview log={log} state={state} turn={turn} run={run} token={token} />
        )}
        {ready && shown === 'network' && (
          <>
            <NetworkFilters filter={filter} onChange={setFilter} />
            <div className="row">
              <Network state={state} filter={filter} selected={company} onSelect={setCompany} />
              <SelectedCompany
                state={state}
                filter={filter}
                selected={company}
                onSelect={setCompany}
                onOpen={openCompany}
              />
            </div>
            <Contracts log={log} state={state} turn={turn} />
          </>
        )}
        {ready && shown === 'companies' && (
          <>
            <Company
              log={log}
              state={state}
              turn={turn}
              token={token}
              runId={runId}
              selected={company}
              onSelect={setCompany}
            />
            <Messages state={state} turn={turn} turns={turns} />
          </>
        )}
      </main>
    </>
  );
}
