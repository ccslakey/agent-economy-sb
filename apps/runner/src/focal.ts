import { contractValue, partyOf, reputationOf, scoreOf } from '@agent-economy/engine';
import {
  type CompanyId,
  type PopulationEntry,
  ROLE_NAMES,
  type RunConfig,
  type RunState,
} from '@agent-economy/schema';

// The focal-company table: one LLM company among scripted bots, measured in its seat against the
// bot that held the same seat in the all-bot run with the same seed. The rest of the chain is
// the same scripted population in both, so the paired difference is the LLM's effect in that role.

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

export type FocalRun = { variant: string; seed: number; state: RunState };

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
const show = (v: number | null): string =>
  v === null ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(2);

/**
 * One block per focal seat, in role order: the mean of each outcome with the LLM in the seat,
 * with the bot in the seat (from the all-bot runs), and the mean paired difference by seed.
 */
export function focalTable(runs: readonly FocalRun[]): string {
  const bots = runs.filter((r) => focalSeat(r.state.config) === null);
  const focal = runs.filter((r) => focalSeat(r.state.config) !== null);
  if (focal.length === 0) return 'no focal runs';
  const seats = new Map<CompanyId, PopulationEntry>();
  for (const r of focal) {
    const seat = focalSeat(r.state.config);
    if (seat !== null) seats.set(seat.id, seat);
  }
  const ordered = [...seats.values()].sort(
    (a, b) => ROLE_NAMES.indexOf(a.role) - ROLE_NAMES.indexOf(b.role) || (a.id < b.id ? -1 : 1),
  );
  const keys = Object.keys(seatOutcome(focal[0]?.state as RunState, ordered[0]?.id as CompanyId));
  const width = 14;
  const blocks: string[] = [];
  for (const seat of ordered) {
    const llmRuns = focal.filter((r) => focalSeat(r.state.config)?.id === seat.id);
    const paired = llmRuns.flatMap((r) => {
      const bot = bots.find((b) => b.seed === r.seed);
      return bot === undefined ? [] : [{ llm: r, bot }];
    });
    const label = (p: string) => (p.length > width - 2 ? p.slice(0, width - 2) : p);
    const header = [
      `${seat.role} ${seat.id} ${seat.name}`.padEnd(32),
      label(`llm (n=${llmRuns.length})`).padStart(width),
      label(`bot (n=${bots.length})`).padStart(width),
      label(`Δ (n=${paired.length})`).padStart(width),
    ];
    const lines = [header.join('')];
    for (const key of keys) {
      const pick = (r: FocalRun) => seatOutcome(r.state, seat.id)[key as keyof SeatOutcome];
      const cells = [
        key.padEnd(32),
        show(mean(llmRuns.map(pick))).padStart(width),
        show(mean(bots.map(pick))).padStart(width),
        show(mean(paired.map((p) => pick(p.llm) - pick(p.bot)))).padStart(width),
      ];
      lines.push(cells.join(''));
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}
