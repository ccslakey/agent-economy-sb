// Inline SVG line charts. No chart library: the dashboard draws a handful of series over turns.

export type Series = {
  label: string;
  /** One value per x, null where the series has no point (a good that did not clear). */
  points: (number | null)[];
  /** Overrides the palette color. */
  color?: string;
  /** Drawn thin and grey behind the others, with no legend entry: context, not a subject. */
  muted?: boolean;
};

const MUTED = '#BCC4CE';
const colorOf = (s: Series, i: number): string =>
  s.muted ? MUTED : (s.color ?? PALETTE[i % PALETTE.length] ?? MUTED);

export const PALETTE = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#7f7f7f',
  '#bcbd22',
  '#17becf',
  '#393b79',
  '#a55194',
];

/** Round a range to about five ticks at a 1, 2, or 5 multiple of a power of ten. */
function ticks(min: number, max: number): number[] {
  const span = max - min || 1;
  const rough = span / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? power;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; ; v += step) {
    out.push(v);
    if (v >= max) return out;
  }
}

export function LineChart({
  title,
  x,
  series,
  marker,
  width = 640,
  height = 220,
}: {
  title: string;
  x: number[];
  series: Series[];
  /** The scrubber's turn, drawn as a vertical line. */
  marker?: number;
  width?: number;
  height?: number;
}) {
  const pad = { left: 56, right: 12, top: 8, bottom: 24 };
  const values = series.flatMap((s) => s.points.filter((p): p is number => p !== null));
  const yMin = Math.min(0, ...values);
  const yMax = Math.max(1, ...values);
  const yTicks = ticks(yMin, yMax);
  const lo = yTicks[0] ?? yMin;
  const hi = yTicks.at(-1) ?? yMax;
  const xMin = x[0] ?? 1;
  const xMax = Math.max(x.at(-1) ?? 1, xMin + 1);
  const sx = (v: number) =>
    pad.left + ((v - xMin) / (xMax - xMin)) * (width - pad.left - pad.right);
  const sy = (v: number) => pad.top + ((hi - v) / (hi - lo || 1)) * (height - pad.top - pad.bottom);
  const path = (points: (number | null)[]) =>
    points
      .map((p, i) => {
        const xi = x[i];
        if (p === null || xi === undefined) return null;
        const prev = points[i - 1];
        return `${i === 0 || prev === null || prev === undefined ? 'M' : 'L'}${sx(xi).toFixed(1)},${sy(p).toFixed(1)}`;
      })
      .filter((d) => d !== null)
      .join(' ');
  return (
    <figure className="chart">
      {title !== '' && <figcaption>{title}</figcaption>}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={title}
        style={{ maxWidth: width * 1.5 }}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={sy(t)} y2={sy(t)} stroke="#E8ECF1" />
            <text x={pad.left - 6} y={sy(t) + 4} className="tick" textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {x.map((t) => (
          <text key={t} x={sx(t)} y={height - 6} className="tick" textAnchor="middle">
            {t}
          </text>
        ))}
        {marker !== undefined && (
          <line
            x1={sx(marker)}
            x2={sx(marker)}
            y1={pad.top}
            y2={height - pad.bottom}
            stroke="#C2410C"
            strokeDasharray="3 4"
          />
        )}
        {[...series.filter((s) => s.muted), ...series.filter((s) => !s.muted)].map((s) => {
          const color = colorOf(s, series.indexOf(s));
          return (
            <g key={s.label} stroke={color} fill={color}>
              <path d={path(s.points)} fill="none" strokeWidth={s.muted ? 1.25 : 1.75} />
              {!s.muted &&
                s.points.map((p, j) => {
                  const xj = x[j];
                  return p === null || xj === undefined ? null : (
                    <circle key={xj} cx={sx(xj)} cy={sy(p)} r={2}>
                      <title>{`${s.label}, turn ${xj}: ${p}`}</title>
                    </circle>
                  );
                })}
            </g>
          );
        })}
      </svg>
      <div className="legend">
        {series.map((s, i) =>
          s.muted ? null : (
            <span key={s.label} style={{ color: colorOf(s, i) }}>
              ■ {s.label}
            </span>
          ),
        )}
      </div>
    </figure>
  );
}
