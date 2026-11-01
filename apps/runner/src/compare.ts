import type { RunMetrics } from '@agent-economy/engine';

// The comparison table for a sweep: one column per variant, one row per metric, and for every
// variant after the first the mean paired difference against it over the seeds they share.

export type ComparedRun = { variant: string; seed: number; metrics: RunMetrics };

/** The metrics the table shows, flattened to one number or null each. */
export function flatten(m: RunMetrics): Record<string, number | null> {
  return {
    turns: m.turns,
    bankruptcies: m.bankruptcies,
    proposed: m.contracts.proposed,
    accepted: m.contracts.accepted,
    completed: m.contracts.completed,
    defaulted: m.contracts.defaulted,
    default_rate: m.default_rate,
    penalties: m.penalties,
    trade_value: m.trade_value,
    welfare: m.welfare,
    gini: m.gini,
    public_messages: m.messages.public,
    dms: m.messages.dm,
    tools_to_npc: m.npc_sales.tool,
    furniture_to_npc: m.npc_sales.furniture,
  };
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

const show = (v: number | null): string =>
  v === null ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(2);

export function compareRuns(runs: ComparedRun[]): string {
  const variants = [...new Set(runs.map((r) => r.variant))];
  const baseline = variants[0];
  if (baseline === undefined) return 'no runs';
  const byVariant = (v: string) => runs.filter((r) => r.variant === v);
  const keys = Object.keys(flatten(runs[0]?.metrics as RunMetrics));
  const header = [
    'metric'.padEnd(18),
    ...variants.map((v) => `${v} (n=${byVariant(v).length})`.padStart(22)),
    ...variants.slice(1).map((v) => `Δ ${v} − ${baseline}`.padStart(24)),
  ];
  const lines = [header.join('')];
  for (const key of keys) {
    const cells = [key.padEnd(18)];
    for (const v of variants) {
      const values = byVariant(v).flatMap((r) => {
        const x = flatten(r.metrics)[key];
        return x === null || x === undefined ? [] : [x];
      });
      cells.push(show(mean(values)).padStart(22));
    }
    for (const v of variants.slice(1)) {
      const diffs = byVariant(v).flatMap((r) => {
        const pair = byVariant(baseline).find((b) => b.seed === r.seed);
        const a = flatten(r.metrics)[key];
        const b = pair === undefined ? null : flatten(pair.metrics)[key];
        return a === null || a === undefined || b === null || b === undefined ? [] : [a - b];
      });
      cells.push(show(mean(diffs)).padStart(24));
    }
    lines.push(cells.join(''));
  }
  return lines.join('\n');
}
