import type { CompanyId, RunState } from '@agent-economy/schema';
import { useMemo, useState } from 'react';
import { messageRows } from '../derive.ts';
import { LineChart } from './Chart.tsx';

export function Messages({
  state,
  turn,
  turns,
  participant: initial = '',
}: {
  state: RunState;
  turn: number;
  /** Every closed turn, so quiet turns still get a zero. */
  turns: number[];
  /** Pre-filters to one company; remount with a key to change it. */
  participant?: string;
}) {
  const [onlyTurn, setOnlyTurn] = useState(false);
  const volume = useMemo(() => messageRows(state, turns), [state, turns]);
  const [participant, setParticipant] = useState(initial);
  // Messages carry no id, so their position in the log is their identity.
  const rows = state.messages
    .map((m, position) => ({ m, position }))
    .filter(
      ({ m }) =>
        (!onlyTurn || m.turn === turn) &&
        (participant === '' ||
          m.from === participant ||
          (m.channel.kind === 'dm' && m.channel.to === participant)),
    );
  const name = (id: CompanyId) => state.companies[id]?.name ?? id;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Messages</h2>
        <div className="toolbar">
          <label className="field">
            <input
              type="checkbox"
              checked={onlyTurn}
              onChange={(e) => setOnlyTurn(e.target.checked)}
            />
            only turn {turn}
          </label>
          <label className="field">
            Participant
            <select value={participant} onChange={(e) => setParticipant(e.target.value)}>
              <option value="">anyone</option>
              {Object.values(state.companies)
                .sort((a, b) => (a.name < b.name ? -1 : 1))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <span className="muted">{rows.length} messages</span>
        </div>
      </div>
      <LineChart
        title="Messages per turn"
        x={turns}
        marker={turn}
        series={[
          { label: 'public', points: volume.map((r) => r.public) },
          { label: 'dm', points: volume.map((r) => r.dm) },
        ]}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map(({ m, position }) => (
          <div key={position} className={m.channel.kind === 'dm' ? 'msg msg-dm' : 'msg'}>
            <div className="msg-head">
              <strong>{name(m.from)}</strong>
              <span>{m.channel.kind === 'dm' ? `DM to ${name(m.channel.to)}` : 'Public'}</span>
              <span className="mono msg-when">
                T{m.turn} · R{m.round}
              </span>
            </div>
            <div className="msg-text">{m.text}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
