import type {
  CompanyId,
  PopulationEntry,
  Provenance,
  RunConfig,
  RunState,
} from '@agent-economy/schema';
import { contractValue, partyOf, reputationOf, scoreOf } from './world.ts';

// What a benchmark reads off a run: the outcome of one seat, which seat the one LLM holds, which
// of several runs of the same game count, and whether the runs were played by the same software.
// Pure over the folded state and the records the API keeps, so the sweep's tables and the
// dashboard's benchmark page compute the same numbers from the same definitions.

export type SeatOutcome = {
  score: number;
  completed: number;
  defaulted: number;
  /** Reference value of every completed contract the seat was party to, both sides. */
  trade_value: number;
  bankrupt: number;
  /** Final scores of every other company, summed: what the seat did to the chain around it. */
  others_score: number;
};

export function seatOutcome(state: RunState, seat: CompanyId): SeatOutcome {
  const company = state.companies[seat];
  if (company === undefined) throw new Error(`no company ${seat} in run ${state.run_id}`);
  const rep = reputationOf(state, company);
  let tradeValue = 0;
  for (const contract of Object.values(state.contracts)) {
    if (contract.status.status !== 'completed' || partyOf(contract, seat) === null) continue;
    tradeValue += contractValue(state, contract.obligations);
  }
  return {
    score: scoreOf(state, company),
    completed: rep.completed,
    defaulted: rep.defaulted,
    trade_value: tradeValue,
    bankrupt: company.standing.kind === 'bankrupt' ? 1 : 0,
    others_score: Object.values(state.companies)
      .filter((c) => c.id !== seat)
      .reduce((sum, c) => sum + scoreOf(state, c), 0),
  };
}

/** The one LLM company of a run, or null when every seat is scripted. A run with several has no focal seat. */
export function focalSeat(config: RunConfig): PopulationEntry | null {
  const llm = config.population.filter((p) => p.driver.kind === 'llm');
  if (llm.length > 1) {
    throw new Error(`${config.experiment_id} has ${llm.length} LLM companies, not one focal seat`);
  }
  return llm[0] ?? null;
}

export type CleanCandidate = {
  id: string;
  experiment: string;
  variant: string;
  seed: number;
  /** ISO time the run was created; the later of two runs of the same game is the one that counts. */
  created_at: string;
  bot_handoffs: number;
};

/**
 * The runs a comparison counts, and why each other run was left out. A run with a bot handoff
 * is replayed, not compared, and when a variant and seed was played more than once only the
 * latest clean run counts, so a replay supersedes the run it replaced instead of weighing twice.
 */
export function latestClean<T extends CleanCandidate>(
  runs: readonly T[],
): { kept: T[]; dropped: { run: T; reason: string }[] } {
  const dropped: { run: T; reason: string }[] = [];
  const clean = runs.filter((r) => {
    if (r.bot_handoffs === 0) return true;
    dropped.push({ run: r, reason: `${r.bot_handoffs} bot handoffs` });
    return false;
  });
  const key = (r: T) => `${r.experiment}/${r.variant}:${r.seed}`;
  const latest = new Map<string, T>();
  for (const r of clean) {
    const held = latest.get(key(r));
    if (held === undefined || held.created_at < r.created_at) latest.set(key(r), r);
  }
  const kept = clean.filter((r) => {
    const winner = latest.get(key(r));
    if (winner === r) return true;
    dropped.push({ run: r, reason: `superseded by ${winner?.id}, played later` });
    return false;
  });
  return { kept, dropped };
}

/** What the provenance route serves for a run: the recorded fields, if any, plus the resolved model ids. */
export type RunProvenance = Partial<Provenance> & { resolved_models?: Record<string, string[]> };

export type ProvenanceOf = { experiment: string; provenance: RunProvenance };

const FIELDS = [
  'source_revision',
  'cli_version',
  'prompt_variant',
  'prompt_sha256',
  'docs_sha256',
  'resolved_models',
] as const;

/** `m7-focal ×10, m7-focal-opus ×3`: which experiments, and how many of their runs, share a value. */
function byExperiment(runs: readonly ProvenanceOf[]): string {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.experiment, (counts.get(r.experiment) ?? 0) + 1);
  return [...counts].map(([e, n]) => `${e} ×${n}`).join(', ');
}

/**
 * One line per provenance field whose value is not the same across the runs, naming each value
 * and the runs that carry it, plus a line for any run played from a dirty source tree. Empty
 * when every run was played by the same software, prompt, docs, and model ids. A run with no
 * record shows as `unrecorded`, and a field that is `unrecorded` or `unknown` for every run
 * still prints, so a table over pre-provenance runs never reads as a verified match.
 */
export function provenanceDifferences(runs: readonly ProvenanceOf[]): string[] {
  const lines: string[] = [];
  for (const field of FIELDS) {
    const values = new Map<string, ProvenanceOf[]>();
    for (const r of runs) {
      const raw = r.provenance[field];
      const value =
        raw === undefined || (typeof raw === 'object' && Object.keys(raw).length === 0)
          ? 'unrecorded'
          : typeof raw === 'string'
            ? raw
            : Object.entries(raw)
                .map(([k, ids]) => `${k}=${ids.join('+')}`)
                .join(' ');
      values.set(value, [...(values.get(value) ?? []), r]);
    }
    const only = values.size === 1 ? [...values.keys()][0] : undefined;
    if (only !== undefined && only !== 'unrecorded' && only !== 'unknown') continue;
    lines.push(
      only !== undefined
        ? `${field} ${only} (${byExperiment(runs)})`
        : `${field} differs: ${[...values].map(([v, rs]) => `${v} (${byExperiment(rs)})`).join(' | ')}`,
    );
  }
  const dirty = runs.filter((r) => r.provenance.source_revision?.endsWith('-dirty'));
  if (dirty.length > 0) lines.push(`dirty source tree: ${byExperiment(dirty)}`);
  return lines;
}
