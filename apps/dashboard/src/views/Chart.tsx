// Inline SVG line charts. No chart library: the dashboard draws a handful of series over turns.

export type Series = {
  label: string;
  /** One value per x, null where the series has no point (a good that did not clear). */
  points: (number | null)[];
};

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
    <figure style={{ margin: '0 0 16px' }}>
      <figcaption style={{ fontSize: 13, fontWeight: 'bold' }}>{title}</figcaption>
      <svg width={width} height={height} role="img" aria-label={title}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={sy(t)} y2={sy(t)} stroke="#eee" />
            <text x={pad.left - 6} y={sy(t) + 4} fontSize={11} textAnchor="end" fill="#555">
              {t}
            </text>
          </g>
        ))}
        {x.map((t) => (
          <text key={t} x={sx(t)} y={height - 6} fontSize={11} textAnchor="middle" fill="#555">
            {t}
          </text>
        ))}
        {marker !== undefined && (
          <line
            x1={sx(marker)}
            x2={sx(marker)}
            y1={pad.top}
            y2={height - pad.bottom}
            stroke="#999"
            strokeDasharray="3 3"
          />
        )}
        {series.map((s, i) => (
          <g key={s.label} stroke={PALETTE[i % PALETTE.length]} fill={PALETTE[i % PALETTE.length]}>
            <path d={path(s.points)} fill="none" strokeWidth={1.5} />
            {s.points.map((p, j) => {
              const xj = x[j];
              return p === null || xj === undefined ? null : (
                <circle key={xj} cx={sx(xj)} cy={sy(p)} r={2}>
                  <title>{`${s.label}, turn ${xj}: ${p}`}</title>
                </circle>
              );
            })}
          </g>
        ))}
      </svg>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 12 }}>
        {series.map((s, i) => (
          <span key={s.label} style={{ color: PALETTE[i % PALETTE.length] }}>
            ■ {s.label}
          </span>
        ))}
      </div>
    </figure>
  );
}
