import { describe, moments } from '@agent-economy/engine';
import type { Event } from '@agent-economy/schema';
import { useMemo } from 'react';
import type { Log } from '../derive.ts';

// Rule-detected moments through the scrubber turn. Every claim cites event ids; hovering a
// citation shows the event it names.

export function Moments({ log, turn }: { log: Log; turn: number }) {
  const through = useMemo(() => log.rest.filter((e) => e.turn <= turn), [log, turn]);
  const found = useMemo(() => moments(log.started, through), [log, through]);
  const byId = useMemo(() => new Map<string, Event>(through.map((e) => [e.id, e])), [through]);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Notable moments</h2>
        <div className="muted">
          Detected from the log through turn {turn} · every claim cites event ids
        </div>
      </div>
      {found.length === 0 && <div className="muted">Nothing notable yet.</div>}
      {found.map((m) => (
        <div key={`${m.kind}-${m.from_turn}-${m.to_turn}`} className="moment">
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
          </div>
        </div>
      ))}
    </section>
  );
}
