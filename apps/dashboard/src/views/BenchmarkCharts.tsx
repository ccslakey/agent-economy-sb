import type { SeatOutcome } from '@agent-economy/engine';
import type { BenchmarkRun } from '../api.ts';
import { type Benchmark, cell, delta, mean, meanDelta, OUTCOMES } from '../benchmarks.ts';
import { fmt, money } from './ui.tsx';

// The benchmark page's charts and the helpers its tables share: the seeds behind one cell, what
// each seat did to the rest of the chain, and what the runs cost.

/** Categorical slots in fixed order: a condition keeps its color however many are shown. */
export const SERIES = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
];
export const BOT = '#6b7280';
export const GRID = '#e8ecf1';

export type Metric = keyof SeatOutcome;
export type Selected = { experiment: string; seat: string };

export const colorOf = (b: Benchmark, experiment: string): string =>
  SERIES[b.conditions.findIndex((c) => c.experiment === experiment)] ?? '#9ca3af';
export const labelOf = (b: Benchmark, experiment: string): string =>
  b.conditions.find((c) => c.experiment === experiment)?.label ?? experiment;
export const show = (v: number | null): string =>
  v === null ? '–' : Number.isInteger(v) ? fmt(v) : v.toFixed(2);
export const signed = (v: number | null): string => (v !== null && v > 0 ? `+${show(v)}` : show(v));
export const metricLabel = (m: Metric): string => OUTCOMES.find((o) => o.key === m)?.label ?? m;

/** Diverging shade for a paired difference: blue when the LLM beat the bot, red when it trailed, gray near zero. */
export function shade(v: number | null, scale: number): { bg: string; fg: string } {
  if (v === null || scale === 0) return { bg: '#f0efec', fg: '#111827' };
  const t = Math.min(1, Math.abs(v) / scale);
  if (t < 0.08) return { bg: '#f0efec', fg: '#111827' };
  const step = t < 0.35 ? 0 : t < 0.65 ? 1 : 2;
  const blue = [
    { bg: '#cde2fb', fg: '#111827' },
    { bg: '#86b6ef', fg: '#111827' },
    { bg: '#1c5cab', fg: '#ffffff' },
  ];
  const red = [
    { bg: '#fbdcdb', fg: '#111827' },
    { bg: '#f1a09e', fg: '#111827' },
    { bg: '#b42b2a', fg: '#ffffff' },
  ];
  return (v > 0 ? blue : red)[step] ?? { bg: '#f0efec', fg: '#111827' };
}

/** Round tick values spanning the data, as 1, 2, or 5 times a power of ten, with the domain widened to them. */
export function axis(lo: number, hi: number, n = 4): { lo: number; hi: number; ticks: number[] } {
  const span = Math.max(hi - lo, 1e-9);
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { lo: start, hi: end, ticks };
}

export /** One panel per condition: each seed is a line from the bot's value to the LLM's in the same seat. */
function PairedSeeds({
  b,
  metric,
  selected,
}: {
  b: Benchmark;
  metric: Metric;
  selected: Selected;
}) {
  const seat = b.seats.find((s) => s.id === selected.seat);
  const cells = b.cells.filter((c) => c.seat.id === selected.seat);
  const values = cells.flatMap((c) => c.pairs.flatMap((p) => [p.llm[metric], p.bot[metric]]));
  if (seat === undefined || values.length === 0) return null;
  const { lo, hi, ticks } = axis(Math.min(0, ...values), Math.max(...values), 3);
  const seeds = [...new Set(cells.flatMap((c) => c.pairs.map((p) => p.seed)))].sort(
    (x, y) => x - y,
  );
  const W = 280;
  const X0 = 44;
  const X1 = W - 12;
  const rowH = 22;
  const H = 16 + seeds.length * rowH + 28;
  const x = (v: number) => X0 + ((v - lo) / (hi - lo)) * (X1 - X0);
  const y = (seed: number) => 16 + seeds.indexOf(seed) * rowH + rowH / 2;
  return (
    <section className="card grow">
      <div className="card-head">
        <h2>
          {metricLabel(metric)} by seed · {seat.role.replaceAll('_', ' ')} {seat.name}
        </h2>
        <div className="legend">
          <span className="legend-item">
            <span className="swatch" style={{ background: BOT }} /> bot in the seat
          </span>
          <span className="legend-item">
            <span className="swatch" style={{ background: '#111827' }} /> LLM in the seat, in the
            condition's color
          </span>
        </div>
      </div>
      <div className="panels">
        {cells.map((c) => {
          const color = colorOf(b, c.experiment);
          return (
            <figure key={c.experiment} className="chart panel">
              <figcaption>
                <span className="swatch" style={{ background: color }} /> {labelOf(b, c.experiment)}
                <span className="muted"> · Δ {signed(meanDelta(c.pairs, metric))}</span>
              </figcaption>
              <svg
                viewBox={`0 0 ${W} ${H}`}
                role="img"
                aria-label={`${metricLabel(metric)} per seed, bot against LLM, ${labelOf(b, c.experiment)}`}
              >
                {ticks.map((v) => (
                  <g key={v}>
                    <line x1={x(v)} x2={x(v)} y1={10} y2={H - 24} stroke={GRID} />
                    <text x={x(v)} y={H - 8} textAnchor="middle" className="tick">
                      {show(v)}
                    </text>
                  </g>
                ))}
                {seeds.map((seed) => (
                  <text key={seed} x={X0 - 8} y={y(seed) + 4} textAnchor="end" className="tick">
                    {seed}
                  </text>
                ))}
                {c.pairs.map((p) => (
                  <g key={p.seed}>
                    <title>{`seed ${p.seed}: bot ${show(p.bot[metric])} → LLM ${show(p.llm[metric])} (Δ ${signed(delta(p, metric))})`}</title>
                    <line
                      x1={x(p.bot[metric])}
                      x2={x(p.llm[metric])}
                      y1={y(p.seed)}
                      y2={y(p.seed)}
                      stroke={color}
                      strokeWidth={2}
                      strokeOpacity={0.5}
                    />
                    <circle cx={x(p.bot[metric])} cy={y(p.seed)} r={4.5} fill={BOT} />
                    <circle
                      cx={x(p.llm[metric])}
                      cy={y(p.seed)}
                      r={5}
                      fill={color}
                      stroke="#fff"
                      strokeWidth={2}
                    />
                  </g>
                ))}
              </svg>
            </figure>
          );
        })}
      </div>
    </section>
  );
}

export /** Grouped bars: what the LLM in each seat did to everyone else's score, by condition. */
function Spillover({ b }: { b: Benchmark }) {
  const bars = b.seats.map((s) => ({
    seat: s,
    values: b.conditions.map((c) => ({
      condition: c,
      v: meanDelta(cell(b, c.experiment, s.id)?.pairs ?? [], 'others_score'),
      n: cell(b, c.experiment, s.id)?.pairs.length ?? 0,
    })),
  }));
  const all = bars.flatMap((g) => g.values.flatMap((d) => (d.v === null ? [] : [d.v])));
  if (all.length === 0) return null;
  const { lo, hi, ticks } = axis(Math.min(0, ...all), Math.max(0, ...all));
  const W = 720;
  const H = 240;
  const X0 = 64;
  const Y0 = 12;
  const Y1 = H - 36;
  const groupW = (W - X0 - 12) / bars.length;
  const barW = Math.min(28, (groupW - 16) / Math.max(1, b.conditions.length));
  const y = (v: number) => Y1 - ((v - lo) / (hi - lo)) * (Y1 - Y0);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Chain spillover: others' score, LLM minus bot</h2>
        <div className="muted">
          The summed final score of every other company, paired by seed · below zero, the LLM in
          that seat cost the rest of the chain
        </div>
      </div>
      <div className="legend">
        {b.conditions.map((c) => (
          <span key={c.experiment} className="legend-item">
            <span className="swatch" style={{ background: colorOf(b, c.experiment) }} /> {c.label}
          </span>
        ))}
      </div>
      <figure className="chart">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Others' score difference by seat and condition"
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={X0} x2={W - 12} y1={y(v)} y2={y(v)} stroke={GRID} />
              <text x={X0 - 8} y={y(v) + 4} textAnchor="end" className="tick">
                {show(v)}
              </text>
            </g>
          ))}
          <line x1={X0} x2={W - 12} y1={y(0)} y2={y(0)} stroke="#111827" />
          {bars.map((g, gi) => {
            const gx = X0 + gi * groupW + (groupW - barW * g.values.length) / 2;
            return (
              <g key={g.seat.id}>
                <text
                  x={X0 + gi * groupW + groupW / 2}
                  y={H - 18}
                  textAnchor="middle"
                  className="tick"
                >
                  {g.seat.role.replaceAll('_', ' ')}
                </text>
                {g.values.map((d, i) =>
                  d.v === null ? null : (
                    <rect
                      key={d.condition.experiment}
                      x={gx + i * barW + 1}
                      width={barW - 2}
                      y={Math.min(y(d.v), y(0))}
                      height={Math.max(1, Math.abs(y(d.v) - y(0)))}
                      rx={3}
                      fill={colorOf(b, d.condition.experiment)}
                    >
                      <title>{`${g.seat.role} · ${d.condition.label}: ${signed(d.v)} (n=${d.n})`}</title>
                    </rect>
                  ),
                )}
              </g>
            );
          })}
        </svg>
      </figure>
    </section>
  );
}

export /** One dot per LLM run: its wall-clock time against its paired score difference, by condition. */
function Cost({ b, metric }: { b: Benchmark; metric: Metric }) {
  const dots = b.cells.flatMap((c) =>
    c.pairs.map((p) => ({
      experiment: c.experiment,
      seat: c.seat,
      seed: p.seed,
      minutes: p.run.cost.duration_ms / 60000,
      d: delta(p, metric),
      run: p.run,
    })),
  );
  if (dots.length === 0) return null;
  const xs = dots.map((d) => d.minutes);
  const ys = dots.map((d) => d.d);
  const xa = axis(0, Math.max(1, ...xs));
  const ya = axis(Math.min(0, ...ys), Math.max(0, ...ys));
  const xhi = xa.hi;
  const ylo = ya.lo;
  const yhi = ya.hi;
  const W = 720;
  const H = 280;
  const X0 = 64;
  const X1 = W - 16;
  const Y0 = 12;
  const Y1 = H - 36;
  const x = (m: number) => X0 + (m / xhi) * (X1 - X0);
  const y = (v: number) => Y1 - ((v - ylo) / (yhi - ylo)) * (Y1 - Y0);
  const rows = b.conditions.map((c) => {
    const runs = [...new Set(dots.filter((d) => d.experiment === c.experiment).map((d) => d.run))];
    const avg = (f: (r: BenchmarkRun) => number) => mean(runs.map(f));
    return {
      condition: c,
      runs: runs.length,
      sessions: avg((r) => r.cost.sessions),
      tokens_in: avg((r) => r.cost.tokens_in),
      tokens_out: avg((r) => r.cost.tokens_out),
      minutes: avg((r) => r.cost.duration_ms / 60000),
      usd: avg((r) => r.cost.cost_usd),
    };
  });
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>{metricLabel(metric)} difference against model time</h2>
          <div className="muted">
            One dot per LLM run · minutes the model spent across the run's sessions
          </div>
        </div>
        <div className="legend">
          {b.conditions.map((c) => (
            <span key={c.experiment} className="legend-item">
              <span className="swatch" style={{ background: colorOf(b, c.experiment) }} /> {c.label}
            </span>
          ))}
        </div>
        <figure className="chart">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label="Paired difference per run against its wall-clock minutes"
          >
            {ya.ticks.map((v) => (
              <g key={`y${v}`}>
                <line x1={X0} x2={X1} y1={y(v)} y2={y(v)} stroke={GRID} />
                <text x={X0 - 8} y={y(v) + 4} textAnchor="end" className="tick">
                  {show(v)}
                </text>
              </g>
            ))}
            {xa.ticks.map((m) => (
              <text key={`x${m}`} x={x(m)} y={H - 14} textAnchor="middle" className="tick">
                {show(m)} min
              </text>
            ))}
            <line x1={X0} x2={X1} y1={y(0)} y2={y(0)} stroke="#111827" />
            {dots.map((d) => (
              <circle
                key={d.run.id}
                cx={x(d.minutes)}
                cy={y(d.d)}
                r={6}
                fill={colorOf(b, d.experiment)}
                fillOpacity={0.85}
                stroke="#fff"
                strokeWidth={2}
              >
                <title>{`${labelOf(b, d.experiment)} · ${d.seat.role} seed ${d.seed}: Δ ${signed(d.d)} in ${d.minutes.toFixed(1)} min`}</title>
              </circle>
            ))}
          </svg>
        </figure>
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Cost per run</h2>
          <div className="muted">Means over the LLM runs paired above</div>
        </div>
        <div className="scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Condition</th>
                <th className="num">Runs</th>
                <th className="num">Sessions</th>
                <th className="num">Tokens in / out</th>
                <th className="num">Minutes</th>
                <th className="num">Nominal $</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.condition.experiment}>
                  <td className="nowrap">
                    <span
                      className="swatch"
                      style={{ background: colorOf(b, r.condition.experiment) }}
                    />{' '}
                    {r.condition.label}
                  </td>
                  <td className="num">{r.runs}</td>
                  <td className="num">{show(r.sessions)}</td>
                  <td className="num">
                    {r.tokens_in === null ? '–' : fmt(Math.round(r.tokens_in))} /{' '}
                    {r.tokens_out === null ? '–' : fmt(Math.round(r.tokens_out))}
                  </td>
                  <td className="num">{r.minutes === null ? '–' : r.minutes.toFixed(1)}</td>
                  <td className="num">{r.usd === null ? '–' : money(r.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
