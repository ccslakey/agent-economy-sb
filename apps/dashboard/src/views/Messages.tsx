import type { RunState } from '@agent-economy/schema';
import { useState } from 'react';
import { cell } from './Contracts.tsx';

export function Messages({ state, turn }: { state: RunState; turn: number }) {
  const [onlyTurn, setOnlyTurn] = useState(false);
  const [participant, setParticipant] = useState('');
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
  return (
    <section>
      <p>
        <label>
          <input
            type="checkbox"
            checked={onlyTurn}
            onChange={(e) => setOnlyTurn(e.target.checked)}
          />{' '}
          only turn {turn}
        </label>{' '}
        <label>
          participant{' '}
          <select value={participant} onChange={(e) => setParticipant(e.target.value)}>
            <option value="">anyone</option>
            {Object.keys(state.companies)
              .sort()
              .map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
          </select>
        </label>{' '}
        {rows.length} messages
      </p>
      <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {['turn', 'round', 'from', 'channel', 'text'].map((h) => (
              <th key={h} style={cell}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ m, position }) => (
            <tr key={position}>
              <td style={cell}>{m.turn}</td>
              <td style={cell}>{m.round}</td>
              <td style={cell}>{m.from}</td>
              <td style={cell}>{m.channel.kind === 'dm' ? `dm to ${m.channel.to}` : 'public'}</td>
              <td style={cell}>{m.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
