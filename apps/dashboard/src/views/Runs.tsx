import type { Knobs } from '@agent-economy/schema';
import type { RunListing } from '../api.ts';
import { Chip, fmt, money, runChip } from './ui.tsx';

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

const population = (p: RunListing['population']) =>
  [
    `${p.llm} llm${p.models.length > 0 ? ` (${p.models.join(', ')})` : ''}`,
    p.bot > 0 ? `${p.bot} bot` : null,
  ]
    .filter((s) => s !== null)
    .join(', ');

export function Runs({ runs, onSelect }: { runs: RunListing[]; onSelect: (id: string) => void }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Run settings</h2>
        <div className="muted">Every run with its knobs and population · click one to open it</div>
      </div>
      <div className="scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Experiment</th>
              <th className="num">Seed</th>
              <th>Status</th>
              <th className="num">Turn</th>
              <th>Horizon</th>
              {KNOB_COLUMNS.map((k) => (
                <th key={k}>{k.replaceAll('_', ' ')}</th>
              ))}
              <th>Population</th>
              <th className="num">Sessions</th>
              <th className="num">Tokens in / out</th>
              <th className="num">Nominal $</th>
              <th>Id</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="pick" onClick={() => onSelect(r.id)}>
                <td className="nowrap">{r.experiment_id}</td>
                <td className="num">{r.seed}</td>
                <td>
                  <Chip kind={runChip(r.status)}>{r.status}</Chip>
                </td>
                <td className="num">{r.turn ?? '-'}</td>
                <td className="nowrap">{horizon(r.knobs.horizon)}</td>
                {KNOB_COLUMNS.map((k) => (
                  <td key={k}>{r.knobs[k]}</td>
                ))}
                <td>{population(r.population)}</td>
                <td className="num">{r.cost.sessions}</td>
                <td className="num">
                  {fmt(r.cost.tokens_in)} / {fmt(r.cost.tokens_out)}
                </td>
                <td className="num">{money(r.cost.cost_usd)}</td>
                <td className="mono muted nowrap">{r.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
