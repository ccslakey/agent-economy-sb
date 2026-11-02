import type { RunMetrics } from '@agent-economy/engine';
import type { Knobs } from '@agent-economy/schema';
import { useEffect, useMemo, useState } from 'react';
import { fetchMetrics, type RunListing } from '../api.ts';
import { Runs } from './Runs.tsx';
import { Chip, delta, fmt, money, runChip } from './ui.tsx';

// Runs side by side: a knob-by-knob heatmap, a dot plot per experiment, and a metrics table.

type Row = { run: RunListing; metrics: RunMetrics };

const DIMENSIONS = [
  'experiment',
  'enforcement',
  'reputation_visibility',
  'model_identity',
  'context_persistence',
  'needs_board',
  'shocks',
  'rebranding',
] as const;
type Dimension = (typeof DIMENSIONS)[number];

const dimensionOf = (r: RunListing, d: Dimension): string =>
  d === 'experiment' ? r.experiment_id : r.knobs[d as keyof Knobs & Dimension];

const METRICS = {
  default_rate: {
    label: 'Default rate',
    of: (r: Row) => r.metrics.default_rate,
    show: (v: number) => `${(v * 100).toFixed(1)}%`,
    badHigh: true,
  },
  net_worth_gained: {
    label: 'Net worth gained',
    of: (r: Row) => r.metrics.net_worth_gained,
    show: delta,
    badHigh: false,
  },
  gini: {
    label: 'Gini',
    of: (r: Row) => r.metrics.gini,
    show: (v: number) => v.toFixed(2),
    badHigh: true,
  },
  trade_value: {
    label: 'Trade value',
    of: (r: Row) => r.metrics.trade_value,
    show: fmt,
    badHigh: false,
  },
  penalties: {
    label: 'Penalties',
    of: (r: Row) => r.metrics.penalties,
    show: fmt,
    badHigh: true,
  },
  bankruptcies: {
    label: 'Bankruptcies',
    of: (r: Row) => r.metrics.bankruptcies,
    show: String,
    badHigh: true,
  },
  dm_share: {
    label: 'DM share of messages',
    of: (r: Row) => r.metrics.dm_share,
    show: (v: number) => `${(v * 100).toFixed(0)}%`,
    badHigh: false,
  },
  cost: {
    label: 'Run cost',
    of: (r: Row) => r.run.cost.cost_usd,
    show: money,
    badHigh: true,
  },
} as const;
type Metric = keyof typeof METRICS;

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

/** Four steps from pale to the orange accent; the worst cell is darkest. */
const SHADES = [
  { bg: '#F1F3F6', fg: '#111827' },
  { bg: '#FBE3D6', fg: '#111827' },
  { bg: '#F2B48F', fg: '#111827' },
  { bg: '#C2410C', fg: '#FFFFFF' },
] as const;

function Pick({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Dimension;
  onChange: (d: Dimension) => void;
}) {
  return (
    <label className="field">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as Dimension)}>
        {DIMENSIONS.map((d) => (
          <option key={d} value={d}>
            {d.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  );
}

function Heatmap({ rows, metric }: { rows: Row[]; metric: Metric }) {
  const [rowDim, setRowDim] = useState<Dimension>('experiment');
  const [colDim, setColDim] = useState<Dimension>('enforcement');
  const m = METRICS[metric];
  const rowKeys = [...new Set(rows.map((r) => dimensionOf(r.run, rowDim)))].sort();
  const colKeys = [...new Set(rows.map((r) => dimensionOf(r.run, colDim)))].sort();
  const cells = rowKeys.map((rk) =>
    colKeys.map((ck) => {
      const values = rows
        .filter((r) => dimensionOf(r.run, rowDim) === rk && dimensionOf(r.run, colDim) === ck)
        .map(m.of)
        .filter((v): v is number => v !== null);
      return {
        avg: mean(values),
        n: values.length,
        lo: Math.min(...values),
        hi: Math.max(...values),
      };
    }),
  );
  const avgs = cells
    .flat()
    .map((c) => c.avg)
    .filter((v): v is number => v !== null);
  const lo = Math.min(...avgs);
  const hi = Math.max(...avgs);
  const shade = (avg: number | null) => {
    if (avg === null || hi === lo) return SHADES[0];
    const t = (avg - lo) / (hi - lo);
    const k = Math.min(3, Math.floor((m.badHigh ? t : 1 - t) * 4));
    return SHADES[k] ?? SHADES[0];
  };
  return (
    <section className="card" style={{ flex: '1 1 420px' }}>
      <div className="card-head">
        <h2>{m.label} by condition</h2>
        <div className="muted">Mean per cell · darker = worse</div>
      </div>
      <div className="toolbar">
        <Pick label="Rows" value={rowDim} onChange={setRowDim} />
        <Pick label="Columns" value={colDim} onChange={setColDim} />
      </div>
      <div className="scroll">
        <div
          className="heat"
          style={{
            gridTemplateColumns: `minmax(120px, auto) repeat(${colKeys.length}, minmax(110px, 1fr))`,
          }}
        >
          <div />
          {colKeys.map((ck) => (
            <div key={ck} className="muted">
              {ck}
            </div>
          ))}
          {rowKeys.map((rk, i) => (
            <RowCells key={rk} label={rk} cells={cells[i] ?? []} shade={shade} show={m.show} />
          ))}
        </div>
      </div>
    </section>
  );
}

function RowCells({
  label,
  cells,
  shade,
  show,
}: {
  label: string;
  cells: { avg: number | null; n: number; lo: number; hi: number }[];
  shade: (avg: number | null) => { bg: string; fg: string };
  show: (v: number) => string;
}) {
  return (
    <>
      <div className="muted" style={{ display: 'flex', alignItems: 'center' }}>
        {label}
      </div>
      {cells.map((c, i) => {
        const s = shade(c.avg);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
          <div key={i} className="heat-cell" style={{ background: s.bg, color: s.fg }}>
            <span className="mono" style={{ fontSize: 22 }}>
              {c.avg === null ? '–' : show(c.avg)}
            </span>
            <span style={{ fontSize: 11 }}>
              {c.n === 0
                ? 'no runs'
                : c.n === 1
                  ? '1 run'
                  : `${c.n} runs · ${show(c.lo)} to ${show(c.hi)}`}
            </span>
          </div>
        );
      })}
    </>
  );
}

function DotPlot({ rows, metric }: { rows: Row[]; metric: Metric }) {
  const m = METRICS[metric];
  const groups = [...new Set(rows.map((r) => r.run.experiment_id))].sort().map((g) => {
    const values = rows
      .filter((r) => r.run.experiment_id === g)
      .map((r) => ({ v: m.of(r), seed: r.run.seed }))
      .filter((d): d is { v: number; seed: number } => d.v !== null);
    return { label: g, values, avg: mean(values.map((d) => d.v)) };
  });
  const all = groups.flatMap((g) => g.values.map((d) => d.v));
  const lo = Math.min(0, ...all);
  const hi = Math.max(...all, lo + 1);
  const X0 = 220;
  const X1 = 700;
  const scaleX = (v: number) => X0 + ((v - lo) / (hi - lo)) * (X1 - X0);
  const rowH = 36;
  const height = 24 + groups.length * rowH + 30;
  const ticks = 4;
  return (
    <section className="card" style={{ flex: '999 1 600px' }}>
      <div className="card-head">
        <h2>{m.label} by experiment</h2>
        <div className="muted">One dot per run, bar = mean</div>
      </div>
      <svg
        viewBox={`0 0 720 ${height}`}
        role="img"
        aria-label={`${m.label} per run, grouped by experiment`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        {Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) * i) / ticks).map((v) => (
          <g key={v}>
            <line x1={scaleX(v)} x2={scaleX(v)} y1={12} y2={height - 28} stroke="#E8ECF1" />
            <text x={scaleX(v)} y={height - 10} textAnchor="middle" className="tick">
              {m.show(v)}
            </text>
          </g>
        ))}
        {groups.map((g, i) => {
          const cy = 30 + i * rowH;
          return (
            <g key={g.label}>
              <text x={X0 - 12} y={cy + 4} textAnchor="end" fontSize={12} fill="#111827">
                {g.label}
              </text>
              {g.avg !== null && (
                <line
                  x1={scaleX(g.avg)}
                  x2={scaleX(g.avg)}
                  y1={cy - 12}
                  y2={cy + 12}
                  stroke="#111827"
                  strokeWidth={2}
                />
              )}
              {g.values.map((d) => (
                <circle
                  key={d.seed}
                  cx={scaleX(d.v)}
                  cy={cy}
                  r={6}
                  fill="#1D4ED8"
                  fillOpacity={0.7}
                >
                  <title>{`seed ${d.seed}: ${m.show(d.v)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
    </section>
  );
}

export function Compare({
  runs,
  token,
  onSelect,
}: {
  runs: RunListing[];
  token: string;
  onSelect: (id: string) => void;
}) {
  const [metrics, setMetrics] = useState<Record<string, RunMetrics>>({});
  const [metric, setMetric] = useState<Metric>('default_rate');
  const [endedOnly, setEndedOnly] = useState(true);
  useEffect(() => {
    for (const r of runs) {
      fetchMetrics(token, r.id).then(
        (m) => setMetrics((prev) => ({ ...prev, [r.id]: m })),
        () => {},
      );
    }
  }, [runs, token]);
  const rows = useMemo(
    (): Row[] =>
      runs.flatMap((run) => {
        const m = metrics[run.id];
        if (m === undefined || (endedOnly && run.status !== 'ended')) return [];
        return [{ run, metrics: m }];
      }),
    [runs, metrics, endedOnly],
  );
  const pending = runs.filter((r) => metrics[r.id] === undefined).length;
  return (
    <>
      <div className="toolbar">
        <h1 style={{ marginRight: 'auto' }}>Compare runs</h1>
        <label className="field">
          <input
            type="checkbox"
            checked={endedOnly}
            onChange={(e) => setEndedOnly(e.target.checked)}
          />
          ended runs only
        </label>
        <label className="field">
          Metric
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {Object.entries(METRICS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        {pending > 0 && <span className="muted">loading {pending} runs…</span>}
      </div>
      {rows.length > 0 && (
        <div className="row">
          <Heatmap rows={rows} metric={metric} />
          <DotPlot rows={rows} metric={metric} />
        </div>
      )}
      <section className="card">
        <div className="card-head">
          <h2>Run metrics</h2>
          <div className="muted">{rows.length} runs · click one to open it</div>
        </div>
        <div className="scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Experiment</th>
                <th className="num">Seed</th>
                <th>Status</th>
                <th className="num">Turns</th>
                <th className="num">Accepted</th>
                <th className="num">Default rate</th>
                <th className="num">Net worth gained</th>
                <th className="num">Gini</th>
                <th className="num">Trade value</th>
                <th className="num">Penalties</th>
                <th className="num">Bankrupt</th>
                <th className="num">DM share</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ run, metrics: m }) => (
                <tr key={run.id} className="pick" onClick={() => onSelect(run.id)}>
                  <td className="nowrap">{run.experiment_id}</td>
                  <td className="num">{run.seed}</td>
                  <td>
                    <Chip kind={runChip(run.status)}>{run.status}</Chip>
                  </td>
                  <td className="num">{m.turns}</td>
                  <td className="num">{m.contracts.accepted}</td>
                  <td className="num">
                    {m.default_rate === null ? '–' : METRICS.default_rate.show(m.default_rate)}
                  </td>
                  <td className="num">{delta(m.net_worth_gained)}</td>
                  <td className="num">{m.gini.toFixed(2)}</td>
                  <td className="num">{fmt(m.trade_value)}</td>
                  <td className="num">{fmt(m.penalties)}</td>
                  <td className="num">{m.bankruptcies}</td>
                  <td className="num">
                    {m.dm_share === null ? '–' : METRICS.dm_share.show(m.dm_share)}
                  </td>
                  <td className="num">{money(run.cost.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <Runs runs={runs} onSelect={onSelect} />
    </>
  );
}
