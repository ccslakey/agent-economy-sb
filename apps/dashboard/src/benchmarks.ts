import { latestClean, provenanceDifferences, type SeatOutcome } from '@agent-economy/engine';
import { ROLE_NAMES } from '@agent-economy/schema';
import type { BenchmarkRun } from './api.ts';

// The benchmark read off the focal design: in each experiment one LLM company sits among
// scripted bots, and the all-bot run with the same seed is its baseline. Every number here is a
// paired difference, LLM minus bot, in the same seat of the same game.

export type Seat = { id: string; role: string; name: string };

/** An experiment with focal runs: one model under one harness, labeled for the page. */
export type Condition = { experiment: string; model: string; harness: number; label: string };

export type Pair = { seed: number; llm: SeatOutcome; bot: SeatOutcome; run: BenchmarkRun };

export type Cell = { experiment: string; seat: Seat; pairs: Pair[]; unpaired: number };

export type Benchmark = {
  conditions: Condition[];
  seats: Seat[];
  cells: Cell[];
  dropped: { run: BenchmarkRun; reason: string }[];
  /** The provenance fields that differ among the runs counted, as the sweep prints them. */
  provenance: string[];
};

export const OUTCOMES: { key: keyof SeatOutcome; label: string }[] = [
  { key: 'score', label: 'Score' },
  { key: 'completed', label: 'Contracts completed' },
  { key: 'defaulted', label: 'Contracts defaulted' },
  { key: 'trade_value', label: 'Trade value' },
  { key: 'bankrupt', label: 'Bankrupt' },
  { key: 'others_score', label: "Others' score" },
];

export const cell = (b: Benchmark, experiment: string, seat: string): Cell | undefined =>
  b.cells.find((c) => c.experiment === experiment && c.seat.id === seat);

export const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

export const delta = (p: Pair, key: keyof SeatOutcome): number => p.llm[key] - p.bot[key];

export const meanDelta = (pairs: readonly Pair[], key: keyof SeatOutcome): number | null =>
  mean(pairs.map((p) => delta(p, key)));

const seatOrder = (a: Seat, b: Seat) =>
  ROLE_NAMES.indexOf(a.role as (typeof ROLE_NAMES)[number]) -
    ROLE_NAMES.indexOf(b.role as (typeof ROLE_NAMES)[number]) || (a.id < b.id ? -1 : 1);

export function benchmark(runs: readonly BenchmarkRun[]): Benchmark {
  const { kept, dropped } = latestClean(runs);
  const focal = kept.filter((r) => r.llm_seats.length === 1);
  const bots = kept.filter((r) => r.llm_seats.length === 0);
  for (const run of kept) {
    if (run.llm_seats.length > 1) {
      dropped.push({ run, reason: `${run.llm_seats.length} LLM seats, not a focal run` });
    }
  }
  const experiments = [...new Set(focal.map((r) => r.experiment))].sort();
  const conditions = experiments.map((experiment) => {
    const seats = focal.filter((r) => r.experiment === experiment).flatMap((r) => r.llm_seats);
    const models = [...new Set(seats.map((s) => s.model))].sort();
    const harnesses = [...new Set(seats.map((s) => s.harness_version))].sort();
    const model = models.join(' / ');
    const harness = harnesses[0] ?? 1;
    return { experiment, model, harness, label: `${model} · harness ${harnesses.join('/')}` };
  });
  const seats = new Map<string, Seat>();
  for (const r of focal) {
    for (const s of r.llm_seats) seats.set(s.id, { id: s.id, role: s.role, name: s.name });
  }
  const ordered = [...seats.values()].sort(seatOrder);
  const cells: Cell[] = [];
  for (const experiment of experiments) {
    for (const seat of ordered) {
      const llmRuns = focal.filter(
        (r) => r.experiment === experiment && r.llm_seats[0]?.id === seat.id,
      );
      if (llmRuns.length === 0) continue;
      const pairs: Pair[] = [];
      let unpaired = 0;
      for (const run of llmRuns) {
        const base = bots.find((b) => b.experiment === experiment && b.seed === run.seed);
        const llm = run.seats[seat.id];
        const bot = base?.seats[seat.id];
        if (llm === undefined || bot === undefined) unpaired += 1;
        else pairs.push({ seed: run.seed, llm, bot, run });
      }
      cells.push({ experiment, seat, pairs: pairs.sort((a, b) => a.seed - b.seed), unpaired });
    }
  }
  const counted = [...focal, ...bots];
  return {
    conditions,
    seats: ordered,
    cells,
    dropped,
    provenance: provenanceDifferences(counted),
  };
}
