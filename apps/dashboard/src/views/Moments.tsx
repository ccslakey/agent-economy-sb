import { describe } from '@agent-economy/engine';
import type { Event, RunMoments } from '@agent-economy/schema';
import { useEffect, useMemo, useState } from 'react';
import { fetchMoments } from '../api.ts';
import type { Log } from '../derive.ts';

// LLM-written moments, each claim tied to event ids the runner checked against the log before
// storing. Hovering a citation shows the event it names.

export function Moments({ token, runId, log }: { token: string; runId: string; log: Log }) {
  const [moments, setMoments] = useState<RunMoments | null | undefined>(undefined);
  useEffect(() => {
    setMoments(undefined);
    fetchMoments(token, runId).then(setMoments, () => setMoments(null));
  }, [token, runId]);
  const byId = useMemo(() => new Map<string, Event>(log.rest.map((e) => [e.id, e])), [log]);
  const cited = moments?.moments.reduce((sum, m) => sum + m.cited, 0) ?? 0;
  const kept = moments?.moments.reduce((sum, m) => sum + m.events.length, 0) ?? 0;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Notable moments</h2>
        {moments != null && (
          <div className="muted">
            Written by {moments.model} on {moments.generated_at.slice(0, 10)} · {kept} of {cited}{' '}
            citations resolve to events in this log
          </div>
        )}
      </div>
      {moments === undefined && <div className="muted">Loading…</div>}
      {moments === null && (
        <div className="muted">
          None written yet. Run this against the API, then reload:
          <pre className="pre" style={{ marginTop: 8 }}>
            {`ADMIN_TOKEN=… node apps/runner/src/moments.ts --api http://localhost:3000 --run ${runId}`}
          </pre>
        </div>
      )}
      {moments != null && moments.moments.length === 0 && (
        <div className="muted">The narrator found nothing it could back with event ids.</div>
      )}
      {moments?.moments.map((m) => (
        <div key={`${m.from_turn}-${m.text.slice(0, 24)}`} className="moment">
          <div className="mono muted moment-turn">
            T{m.from_turn}
            {m.to_turn === m.from_turn ? '' : `–${m.to_turn}`}
          </div>
          <div className="moment-text">{m.text}</div>
          <div className="moment-cites">
            {m.events.map((id) => {
              const e = byId.get(id);
              return (
                <span
                  key={id}
                  className="cite"
                  title={e === undefined ? id : `T${e.turn} ${e.actor ?? 'engine'}: ${describe(e)}`}
                >
                  ev {id.slice(id.lastIndexOf(':') + 1)}
                </span>
              );
            })}
            {m.cited > m.events.length && (
              <span className="muted">{m.cited - m.events.length} dropped</span>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
