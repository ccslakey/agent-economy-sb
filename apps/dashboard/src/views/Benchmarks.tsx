import { useEffect, useMemo, useState } from 'react';
import { type BenchmarkRun, fetchBenchmarks, type RunListing } from '../api.ts';
import {
  type Benchmark,
  benchmark,
  cell,
  mean,
  meanDelta,
  OUTCOMES,
  type Pair,
} from '../benchmarks.ts';
import {
  Cost,
  colorOf,
  labelOf,
  type Metric,
  metricLabel,
  PairedSeeds,
  type Selected,
  Spillover,
  shade,
  show,
  signed,
} from './BenchmarkCharts.tsx';
import { Chip } from './ui.tsx';

// The benchmark page: every model that played the focal design, read against the bot that held
// the same seat in the same game. A scorecard of paired differences by condition and seat, the
// seeds behind one cell, what each seat did to the rest of the chain, what the runs cost, and
// the provenance that differs among the runs counted.

function Provenance({ b }: { b: Benchmark }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Provenance</h2>
        <div className="muted">
          What differs among the runs counted · the same lines the sweep prints
        </div>
      </div>
      {b.provenance.length === 0 ? (
        <div>
          <Chip kind="ok">same software, prompt, docs, and model ids across every run</Chip>
        </div>
      ) : (
        <ul className="prov">
          {b.provenance.map((line) => (
            <li key={line} className="mono">
              <Chip kind="warn">differs</Chip> {line}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Scorecard({
  b,
  metric,
  selected,
  onSelect,
}: {
  b: Benchmark;
  metric: Metric;
  selected: Selected | null;
  onSelect: (s: Selected) => void;
}) {
  const scale = Math.max(0, ...b.cells.map((c) => Math.abs(meanDelta(c.pairs, metric) ?? 0)));
  return (
    <section className="card">
      <div className="card-head">
        <h2>{metricLabel(metric)}: LLM minus bot, by seat</h2>
        <div className="muted">
          Mean paired difference by seed · blue = the LLM beat the bot · click a cell for its seeds
        </div>
      </div>
      <div className="scroll">
        <table className="data scorecard">
          <thead>
            <tr>
              <th>Condition</th>
              {b.seats.map((s) => (
                <th key={s.id}>
                  {s.role.replaceAll('_', ' ')}
                  <div className="muted">{s.name}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.conditions.map((c) => (
              <tr key={c.experiment}>
                <td className="nowrap">
                  <span className="swatch" style={{ background: colorOf(b, c.experiment) }} />{' '}
                  {c.label}
                  <div className="muted">{c.experiment}</div>
                </td>
                {b.seats.map((s) => {
                  const k = cell(b, c.experiment, s.id);
                  const v = k === undefined ? null : meanDelta(k.pairs, metric);
                  const tone = shade(v, scale);
                  const picked = selected?.experiment === c.experiment && selected.seat === s.id;
                  return (
                    <td key={s.id}>
                      <button
                        type="button"
                        className="score-cell"
                        aria-pressed={picked}
                        disabled={k === undefined}
                        style={{ background: tone.bg, color: tone.fg }}
                        onClick={() => onSelect({ experiment: c.experiment, seat: s.id })}
                      >
                        <span className="mono">{signed(v)}</span>
                        <span style={{ fontSize: 11 }}>
                          {k === undefined
                            ? 'no runs'
                            : `${k.pairs.length} paired${k.unpaired > 0 ? ` · ${k.unpaired} unpaired` : ''}`}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SeatDetail({ b, selected }: { b: Benchmark; selected: Selected }) {
  const k = cell(b, selected.experiment, selected.seat);
  if (k === undefined) return null;
  const pick = (f: (p: Pair) => number) => mean(k.pairs.map(f));
  return (
    <section className="card side">
      <div className="card-head">
        <h2>{labelOf(b, selected.experiment)}</h2>
        <div className="muted">
          {k.seat.role.replaceAll('_', ' ')} {k.seat.name} · {k.pairs.length} paired seeds
        </div>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Outcome</th>
            <th className="num">LLM</th>
            <th className="num">Bot</th>
            <th className="num">Δ</th>
          </tr>
        </thead>
        <tbody>
          {OUTCOMES.map((o) => (
            <tr key={o.key}>
              <td>{o.label}</td>
              <td className="num">{show(pick((p) => p.llm[o.key]))}</td>
              <td className="num">{show(pick((p) => p.bot[o.key]))}</td>
              <td className="num">{signed(meanDelta(k.pairs, o.key))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Experiments in the focal design: at least one ended run with one LLM seat and one with none. */
function focalExperiments(runs: readonly RunListing[]): string[] {
  const llm = new Set<string>();
  const bots = new Set<string>();
  for (const r of runs) {
    if (r.status !== 'ended') continue;
    const experiment = r.experiment_id.split('/')[0] ?? r.experiment_id;
    if (r.population.llm === 1) llm.add(experiment);
    if (r.population.llm === 0) bots.add(experiment);
  }
  return [...llm].filter((e) => bots.has(e)).sort();
}

export function Benchmarks({
  runs,
  token,
  onSelect,
}: {
  runs: RunListing[];
  token: string;
  onSelect: (id: string) => void;
}) {
  const available = useMemo(() => focalExperiments(runs), [runs]);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const picked = chosen ?? available;
  const [data, setData] = useState<BenchmarkRun[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>('score');
  const [selected, setSelected] = useState<Selected | null>(null);
  const key = picked.join(',');
  useEffect(() => {
    if (key === '') {
      setData([]);
      return;
    }
    setLoading(true);
    fetchBenchmarks(token, key.split(',')).then(
      (rs) => {
        setData(rs);
        setError(null);
        setLoading(false);
      },
      (e: Error) => {
        setError(e.message);
        setLoading(false);
      },
    );
  }, [key, token]);
  const b = useMemo(() => (data === null ? null : benchmark(data)), [data]);
  const first = b?.cells[0];
  const current: Selected | null =
    selected !== null && b !== null && cell(b, selected.experiment, selected.seat) !== undefined
      ? selected
      : first === undefined
        ? null
        : { experiment: first.experiment, seat: first.seat.id };
  const toggle = (e: string) =>
    setChosen(picked.includes(e) ? picked.filter((x) => x !== e) : [...picked, e].sort());
  return (
    <>
      <div className="toolbar">
        <h1 style={{ marginRight: 'auto' }}>Benchmarks</h1>
        <label className="field">
          Outcome
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {OUTCOMES.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {loading && <span className="muted">loading…</span>}
      </div>
      <fieldset className="pills">
        <legend className="muted">Experiments in the focal design · one LLM seat among bots</legend>
        {available.map((e) => (
          <button
            key={e}
            type="button"
            className="pill"
            aria-pressed={picked.includes(e)}
            onClick={() => toggle(e)}
          >
            {e}
          </button>
        ))}
        {available.length === 0 && (
          <span className="muted">no focal experiments have ended runs</span>
        )}
      </fieldset>
      {error !== null && <p className="error">{error}</p>}
      {b !== null && b.cells.length > 0 && current !== null && (
        <>
          <Provenance b={b} />
          <Scorecard b={b} metric={metric} selected={current} onSelect={setSelected} />
          <div className="row">
            <PairedSeeds b={b} metric={metric} selected={current} />
            <SeatDetail b={b} selected={current} />
          </div>
          <Spillover b={b} />
          <Cost b={b} metric={metric} />
          {b.dropped.length > 0 && (
            <details>
              <summary>{b.dropped.length} runs left out</summary>
              <ul className="prov">
                {b.dropped.map((d) => (
                  <li key={d.run.id} className="mono">
                    <button type="button" className="link" onClick={() => onSelect(d.run.id)}>
                      {d.run.experiment}/{d.run.variant} seed {d.run.seed}
                    </button>{' '}
                    · {d.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {b !== null && b.cells.length === 0 && !loading && (
        <p className="muted">No paired runs among the experiments chosen.</p>
      )}
    </>
  );
}
