import type { CompanyId } from '@agent-economy/schema';
import { useEffect, useState } from 'react';
import { fetchTraces, type Trace as TraceRow } from '../api.ts';
import { fmt, money } from './ui.tsx';

// What the agent wrote at the end of each round, with the session's cost. The CLI keeps no
// reasoning or tool calls, so this is the trace as far as the runner captured it.

const label = (t: TraceRow) =>
  t.kind === 'farming' ? `T${t.turn} · farming answer` : `T${t.turn} · round ${t.round ?? '?'}`;

export function Trace({
  token,
  runId,
  company,
  turn,
}: {
  token: string;
  runId: string;
  company: CompanyId;
  /** The scrubber's turn; the panel opens on the last round at or before it. */
  turn: number;
}) {
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [index, setIndex] = useState<number | null>(null);
  useEffect(() => {
    setTraces([]);
    setIndex(null);
    fetchTraces(token, runId, company).then(
      (rows) =>
        setTraces([...rows].sort((a, b) => a.turn - b.turn || (a.round ?? 99) - (b.round ?? 99))),
      () => setTraces([]),
    );
  }, [token, runId, company]);
  // Follow the scrubber until the reader pages by hand, then stay put.
  const auto = traces.findLastIndex((t) => t.turn <= turn);
  const at = index ?? Math.max(0, auto);
  const trace = traces[at];
  if (traces.length === 0) {
    return (
      <section className="card grow">
        <h2>Round summaries</h2>
        <div className="muted">No sessions recorded for this company.</div>
      </section>
    );
  }
  const thinking = trace?.result.usage?.output_tokens_details?.thinking_tokens;
  return (
    <section className="card grow">
      <div className="card-head">
        <h2>Round summary · {trace === undefined ? '' : label(trace)}</h2>
        {trace !== undefined && (
          <div className="muted">
            {trace.model ?? 'unknown model'} · {fmt(trace.tokens_in)} in · {fmt(trace.tokens_out)}{' '}
            out{thinking === undefined ? '' : ` · ${fmt(thinking)} thinking`} ·{' '}
            {money(trace.cost_usd)} · {(trace.duration_ms / 1000).toFixed(0)}s
          </div>
        )}
      </div>
      <div className="muted">
        What the agent wrote when its session ended. The CLI records no reasoning or tool calls.
      </div>
      <pre className="pre">{trace?.result.result ?? '(empty)'}</pre>
      <div className="toolbar">
        <button
          type="button"
          className="btn"
          disabled={at === 0}
          onClick={() => setIndex(Math.max(0, at - 1))}
        >
          Previous round
        </button>
        <button
          type="button"
          className="btn"
          disabled={at >= traces.length - 1}
          onClick={() => setIndex(Math.min(traces.length - 1, at + 1))}
        >
          Next round
        </button>
        <span className="muted">
          {at + 1} of {traces.length} sessions
        </span>
      </div>
    </section>
  );
}
