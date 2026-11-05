import { focalSeat, type SeatOutcome, seatOutcome } from '@agent-economy/engine';
import {
  type CompanyId,
  type PopulationEntry,
  ROLE_NAMES,
  type RunState,
} from '@agent-economy/schema';

// The focal-company table: one LLM company among scripted bots, measured in its seat against the
// bot that held the same seat in the all-bot run with the same seed. The rest of the chain is
// the same scripted population in both, so the paired difference is the LLM's effect in that role.

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
