import type { Knobs } from '@agent-economy/schema';
import type { RunListing } from '../api.ts';
import { cell } from './Contracts.tsx';

const horizon = (h: Knobs['horizon']) =>
  h.kind === 'fixed' ? `fixed ${h.last_turn}` : `random ≥${h.min_turns} @${h.hazard}`;

/** Knobs shown in the list, in column order. Horizon has its own column. */
const KNOB_COLUMNS = [
  'enforcement',
  'reputation_visibility',
  'model_identity',
  'context_persistence',
  'needs_board',
  'shocks',
] as const satisfies readonly (keyof Knobs)[];

export function Runs({ runs, onSelect }: { runs: RunListing[]; onSelect: (id: string) => void }) {
  return (
    <section>
      <p>{runs.length} runs. Click one to open it.</p>
      <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {[
              'experiment',
              'seed',
              'status',
              'turn',
              'horizon',
              ...KNOB_COLUMNS.map((k) => k.replace('_', ' ')),
              'population',
              'sessions',
              'tokens in / out',
              'nominal $',
              'id',
            ].map((h) => (
              <th key={h} style={cell}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} onClick={() => onSelect(r.id)} style={{ cursor: 'pointer' }}>
              <td style={cell}>{r.experiment_id}</td>
              <td style={cell}>{r.seed}</td>
              <td style={cell}>{r.status}</td>
              <td style={cell}>{r.turn ?? '-'}</td>
              <td style={cell}>{horizon(r.knobs.horizon)}</td>
              {KNOB_COLUMNS.map((k) => (
                <td key={k} style={cell}>
                  {r.knobs[k]}
                </td>
              ))}
              <td style={cell}>
                {r.population.llm} llm
                {r.population.models.length > 0 && ` (${r.population.models.join(', ')})`}
                {r.population.bot > 0 && `, ${r.population.bot} bot`}
              </td>
              <td style={cell}>{r.cost.sessions}</td>
              <td style={cell}>
                {r.cost.tokens_in.toLocaleString()} / {r.cost.tokens_out.toLocaleString()}
              </td>
              <td style={cell}>{r.cost.cost_usd.toFixed(2)}</td>
              <td style={cell}>{r.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
