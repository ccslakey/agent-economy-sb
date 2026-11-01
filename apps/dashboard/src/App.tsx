import type { Event, RunState } from '@agent-economy/schema';
import { useEffect, useMemo, useState } from 'react';
import { fetchEvents, listRuns, type RunListing, savedToken, saveToken } from './api.ts';
import { type Log, lastTurn, splitLog, stateAt } from './derive.ts';
import { Company } from './views/Company.tsx';
import { Contracts } from './views/Contracts.tsx';
import { Leaderboard } from './views/Leaderboard.tsx';
import { Messages } from './views/Messages.tsx';
import { Runs } from './views/Runs.tsx';
import { World } from './views/World.tsx';

const VIEWS = ['world', 'leaderboard', 'contracts', 'messages', 'company'] as const;
type View = (typeof VIEWS)[number];

export function App() {
  const [token, setToken] = useState(savedToken);
  const [runs, setRuns] = useState<RunListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [turn, setTurn] = useState<number | null>(null);
  const [view, setView] = useState<View>('world');

  useEffect(() => {
    if (token === '') return;
    saveToken(token);
    listRuns(token).then(setRuns, (e: Error) => setError(e.message));
  }, [token]);

  useEffect(() => {
    if (runId === null || token === '') return;
    setLog(null);
    fetchEvents(token, runId).then(
      (events: Event[]) => {
        const split = splitLog(events);
        setLog(split);
        setTurn(split === null ? null : lastTurn(split));
      },
      (e: Error) => setError(e.message),
    );
  }, [runId, token]);

  const state: RunState | null = useMemo(
    () => (log === null ? null : stateAt(log, turn)),
    [log, turn],
  );

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 1400 }}>
      <h1 style={{ fontSize: 20 }}>Agent Economy Inspector</h1>
      <p>
        <label>
          Admin token{' '}
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            size={40}
            type="password"
          />
        </label>
      </p>
      {error !== null && <p style={{ color: 'crimson' }}>{error}</p>}
      {runs !== null && runId === null && <Runs runs={runs} onSelect={setRunId} />}
      {runs !== null && runId !== null && (
        <p>
          <button type="button" onClick={() => setRunId(null)}>
            all runs
          </button>{' '}
          <label>
            Run{' '}
            <select value={runId} onChange={(e) => setRunId(e.target.value || null)}>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.experiment_id} seed {r.seed} ({r.status}, turn {r.turn ?? '-'}) {r.id}
                </option>
              ))}
            </select>
          </label>
        </p>
      )}
      {log !== null && state !== null && turn !== null && (
        <>
          <p>
            <label>
              Turn {turn} of {lastTurn(log)}{' '}
              <input
                type="range"
                min={1}
                max={lastTurn(log)}
                value={turn}
                onChange={(e) => setTurn(Number(e.target.value))}
                style={{ width: 400, verticalAlign: 'middle' }}
              />
            </label>{' '}
            phase {state.phase.kind}
          </p>
          <nav style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                style={{ fontWeight: view === v ? 'bold' : 'normal' }}
              >
                {v}
              </button>
            ))}
          </nav>
          {view === 'world' && <World log={log} state={state} turn={turn} />}
          {view === 'leaderboard' && <Leaderboard log={log} turn={turn} />}
          {view === 'contracts' && <Contracts state={state} />}
          {view === 'messages' && <Messages state={state} turn={turn} />}
          {view === 'company' && runId !== null && (
            <Company log={log} state={state} turn={turn} token={token} runId={runId} />
          )}
        </>
      )}
    </main>
  );
}
