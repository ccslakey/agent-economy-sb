import type { RunState } from '@agent-economy/schema';
import { useMemo } from 'react';
import type { RunListing } from '../api.ts';
import { defaultRateByDriver, type Log, lastTurn, metricsAt } from '../derive.ts';
import { Cost } from './Cost.tsx';
import { Leaderboard, NetWorth } from './Leaderboard.tsx';
import { delta, fmt, money } from './ui.tsx';
import { Prices, World } from './World.tsx';

const pct = (rate: number | null) => (rate === null ? '–' : `${(rate * 100).toFixed(1)}%`);

function Kpis({
  log,
  state,
  turn,
  run,
}: {
  log: Log;
  state: RunState;
  turn: number;
  run: RunListing;
}) {
  const m = useMemo(() => metricsAt(log, turn), [log, turn]);
  const unmet = Object.values(state.contracts).reduce(
    (sum, k) => sum + (k.status.status === 'defaulted' ? k.status.unmet_value : 0),
    0,
  );
  const kpis = [
    {
      label: 'Turns played',
      value: `${turn} / ${lastTurn(log)}`,
      sub: `${m.bankruptcies} ${m.bankruptcies === 1 ? 'bankruptcy' : 'bankruptcies'} · ${m.bot_handoffs} bot handoffs`,
    },
    {
      label: 'Contracts accepted',
      value: fmt(m.contracts.accepted),
      sub: `${m.contracts.completed} completed · ${m.contracts.defaulted} defaulted`,
    },
    {
      label: 'Default rate',
      value: pct(m.default_rate),
      sub: `${fmt(unmet)} in goods and cash never delivered`,
    },
    {
      label: 'Trade value',
      value: fmt(m.trade_value),
      sub: `Completed contracts, both sides · ${fmt(m.penalties)} in penalties`,
    },
    {
      label: 'Total welfare',
      value: delta(m.welfare),
      sub: `Net worth gained, all companies · Gini ${m.gini.toFixed(2)}`,
    },
    {
      label: 'Run cost',
      value: money(run.cost.cost_usd),
      sub: `${fmt(run.cost.sessions)} agent rounds · ${fmt(run.cost.tokens_in + run.cost.tokens_out)} tokens`,
    },
  ];
  return (
    <section className="kpis" aria-label="Run totals">
      {kpis.map((k) => (
        <div key={k.label} className="kpi">
          <div className="muted">{k.label}</div>
          <div className="value">{k.value}</div>
          <div className="muted">{k.sub}</div>
        </div>
      ))}
    </section>
  );
}

function DefaultByDriver({ state, turn }: { state: RunState; turn: number }) {
  const rows = useMemo(() => defaultRateByDriver(state, turn), [state, turn]);
  const worst = rows[0]?.rate ?? 0;
  return (
    <section className="card side">
      <div className="card-head">
        <h2>Default rate by driver</h2>
      </div>
      <div className="muted">Share of each model's closed contracts it defaulted on</div>
      {rows.map((r) => (
        <div key={r.driver} className="bar-row">
          <div className="bar-label">
            <span>
              {r.driver} <span className="muted">· {r.companies} companies</span>
            </span>
            <span className="mono">{pct(r.rate)}</span>
          </div>
          <div className="bar">
            <div
              className="bar-fill"
              style={{
                width: `${worst === 0 ? 0 : ((r.rate ?? 0) / worst) * 100}%`,
                background: (r.rate ?? 0) >= 0.15 ? 'var(--orange)' : '#6B7280',
              }}
            />
          </div>
        </div>
      ))}
    </section>
  );
}

export function Overview({
  log,
  state,
  turn,
  run,
  token,
}: {
  log: Log;
  state: RunState;
  turn: number;
  run: RunListing;
  token: string;
}) {
  return (
    <>
      <Kpis log={log} state={state} turn={turn} run={run} />
      <div className="row">
        <NetWorth log={log} turn={turn} />
        <DefaultByDriver state={state} turn={turn} />
      </div>
      <div className="row">
        <Leaderboard log={log} turn={turn} />
        <Prices log={log} turn={turn} />
      </div>
      <World log={log} state={state} turn={turn} />
      <Cost token={token} runId={run.id} />
    </>
  );
}
