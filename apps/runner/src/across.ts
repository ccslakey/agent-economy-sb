// The table across experiments: one block per group (a sweep variant, or a focal seat), one
// column per experiment, and for every experiment after the first the mean paired difference
// against it over the seeds the group has in both. This is how two models, or two months, are
// compared: each experiment is one model or one date, and the seeds pair the games.

export type AcrossRun = {
  experiment: string;
  group: string;
  seed: number;
  values: Record<string, number | null>;
};

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
const show = (v: number | null): string =>
  v === null ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(2);

export function acrossTable(experiments: readonly string[], runs: readonly AcrossRun[]): string {
  const baseline = experiments[0];
  if (baseline === undefined || runs.length === 0) return 'no runs';
  const groups = [...new Set(runs.map((r) => r.group))];
  const keys = Object.keys(runs[0]?.values ?? {});
  const blocks: string[] = [];
  for (const group of groups) {
    const of = (experiment: string) =>
      runs.filter((r) => r.group === group && r.experiment === experiment);
    const paired = (experiment: string) =>
      of(experiment).flatMap((r) => {
        const base = of(baseline).find((b) => b.seed === r.seed);
        return base === undefined ? [] : [{ run: r, base }];
      });
    const labels = [
      ...experiments.map((e) => `${e} (n=${of(e).length})`),
      ...experiments.slice(1).map((e) => `Δ ${e} − ${baseline} (n=${paired(e).length})`),
    ];
    const width = Math.max(14, ...labels.map((l) => l.length)) + 2;
    const lines = [[group.padEnd(32), ...labels.map((l) => l.padStart(width))].join('')];
    for (const key of keys) {
      const value = (r: AcrossRun): number | null => r.values[key] ?? null;
      const cells = [key.padEnd(32)];
      for (const e of experiments) {
        const values = of(e).flatMap((r) => {
          const x = value(r);
          return x === null ? [] : [x];
        });
        cells.push(show(mean(values)).padStart(width));
      }
      for (const e of experiments.slice(1)) {
        const diffs = paired(e).flatMap(({ run, base }) => {
          const a = value(run);
          const b = value(base);
          return a === null || b === null ? [] : [a - b];
        });
        cells.push(show(mean(diffs)).padStart(width));
      }
      lines.push(cells.join(''));
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}
