import {
  apply,
  contractValue,
  initialState,
  type RunMetrics,
  reputationOf,
  runMetrics,
  scoreOf,
} from '@agent-economy/engine';
import type {
  Company,
  CompanyId,
  Contract,
  Event,
  EventOf,
  FinalGood,
  Good,
  RunState,
} from '@agent-economy/schema';

// Everything the inspector shows is a fold over the event log, done in the browser. The turn
// scrubber is "fold up to here". No projection tables are involved.

export type Log = { started: EventOf<'run_started'>; rest: Event[] };

export function splitLog(events: readonly Event[]): Log | null {
  const [started, ...rest] = events;
  if (started?.type !== 'run_started') return null;
  return { started, rest };
}

/** State as it stood at the end of `turn`, or the latest state when `turn` is null. */
export function stateAt(log: Log, turn: number | null): RunState {
  let state = initialState(log.started);
  for (const event of log.rest) {
    if (turn !== null && event.turn > turn) break;
    state = apply(state, event);
  }
  return state;
}

export function lastTurn(log: Log): number {
  return log.rest.at(-1)?.turn ?? 1;
}

export type TurnRow = {
  turn: number;
  /** State after this turn's operations. */
  state: RunState;
  /** Units extracted or produced during the turn, by good. */
  output: Partial<Record<Good, number>>;
  /** Cash destroyed by penalties during the turn. */
  penalties: number;
  /** Contract lifecycle events during the turn. */
  contracts: Record<ContractMove, number>;
};

export const CONTRACT_MOVES = ['proposed', 'accepted', 'completed', 'defaulted'] as const;
export type ContractMove = (typeof CONTRACT_MOVES)[number];
const noMoves = (): Record<ContractMove, number> => ({
  proposed: 0,
  accepted: 0,
  completed: 0,
  defaulted: 0,
});

/** One row per closed turn. The final turn closes with `run_ended` instead of `turn_closed`. */
export function byTurn(log: Log): TurnRow[] {
  const rows: TurnRow[] = [];
  let state = initialState(log.started);
  let output: Partial<Record<Good, number>> = {};
  let penalties = 0;
  let contracts = noMoves();
  for (const event of log.rest) {
    state = apply(state, event);
    if (event.type === 'extraction_completed' || event.type === 'production_completed') {
      output[event.payload.good] = (output[event.payload.good] ?? 0) + event.payload.qty;
    } else if (event.type === 'penalty_charged') {
      penalties += event.payload.amount;
    } else if (
      event.type === 'contract_proposed' ||
      event.type === 'contract_accepted' ||
      event.type === 'contract_completed' ||
      event.type === 'contract_defaulted'
    ) {
      contracts[event.type.slice('contract_'.length) as ContractMove] += 1;
    } else if (event.type === 'turn_closed' || event.type === 'run_ended') {
      rows.push({ turn: event.turn, state, output, penalties, contracts });
      output = {};
      penalties = 0;
      contracts = noMoves();
    }
  }
  return rows;
}

export type CompanySnapshot = {
  turn: number;
  cash: number;
  inventory: Company['inventory'];
  score: number;
  standing: Company['standing']['kind'];
};

/** One row per turn for a company: cash, inventory, and score after that turn's operations. */
export function snapshots(log: Log, company: CompanyId): CompanySnapshot[] {
  return byTurn(log).flatMap(({ turn, state }) => {
    const c = state.companies[company];
    if (c === undefined) return [];
    return [
      {
        turn,
        cash: c.cash,
        inventory: c.inventory,
        score: scoreOf(state, c),
        standing: c.standing.kind,
      },
    ];
  });
}

export type WorldRow = {
  turn: number;
  /** Cash across every company, overdrafts included. */
  money: number;
  solvent: number;
  /** NPC clearing price per final good, absent when nothing cleared. */
  prices: Partial<Record<FinalGood, number>>;
  output: Partial<Record<Good, number>>;
  groves: number;
  penalties: number;
  shocks: string[];
};

export function worldRows(log: Log): WorldRow[] {
  return byTurn(log).map(({ turn, state, output, penalties }) => {
    const companies = Object.values(state.companies);
    const prices: Partial<Record<FinalGood, number>> = {};
    for (const clear of state.market.clears)
      if (clear.turn === turn) prices[clear.good] = clear.price;
    return {
      turn,
      money: companies.reduce((sum, c) => sum + c.cash, 0),
      solvent: companies.filter((c) => c.standing.kind !== 'bankrupt').length,
      prices,
      output,
      groves: Object.values(state.groves).reduce((sum, g) => sum + g.stock, 0),
      penalties,
      shocks: state.shocks.map((s) => s.shock.kind),
    };
  });
}

export type LeaderboardSeries = {
  company: Company;
  driver: string;
  /** Net worth after each turn, aligned with `turns`. */
  scores: number[];
};

/** Every company's net worth over the game, sorted by final score. */
export function leaderboard(log: Log): { turns: number[]; series: LeaderboardSeries[] } {
  const rows = byTurn(log);
  const last = rows.at(-1);
  if (last === undefined) return { turns: [], series: [] };
  const series = Object.values(last.state.companies).map((company) => ({
    company,
    driver: driverLabel(last.state, company.id),
    scores: rows.map((r) => {
      const c = r.state.companies[company.id];
      return c === undefined ? 0 : scoreOf(r.state, c);
    }),
  }));
  series.sort((a, b) => (b.scores.at(-1) ?? 0) - (a.scores.at(-1) ?? 0));
  return { turns: rows.map((r) => r.turn), series };
}

/** The first turn from which the current leader has led every turn since. */
export function leaderSince(
  turns: number[],
  series: LeaderboardSeries[],
  upTo: number,
): number | null {
  const index = turns.indexOf(upTo);
  if (index < 0) return null;
  const leaderAt = (i: number) =>
    series.reduce((best, s) => ((s.scores[i] ?? 0) > (best.scores[i] ?? 0) ? s : best)).company.id;
  const leader = leaderAt(index);
  let since = index;
  while (since > 0 && leaderAt(since - 1) === leader) since -= 1;
  return turns[since] ?? null;
}

/** The spec's run metrics folded through the end of `turn`. */
export function metricsAt(log: Log, turn: number): RunMetrics {
  return runMetrics(
    log.started,
    log.rest.filter((e) => e.turn <= turn),
  );
}

export type DriverRate = {
  driver: string;
  companies: number;
  /** Completed plus defaulted contracts, counted once per party. */
  closed: number;
  defaulted: number;
  rate: number | null;
};

/** Defaults over closures per driver (a model, or a bot strategy) as of `turn`, worst first. */
export function defaultRateByDriver(state: RunState, turn: number): DriverRate[] {
  const tallies = new Map<string, DriverRate>();
  for (const c of Object.values(state.companies)) {
    const driver = driverLabel(state, c.id);
    const rep = reputationOf(state, c, turn);
    const t = tallies.get(driver) ?? { driver, companies: 0, closed: 0, defaulted: 0, rate: null };
    t.companies += 1;
    t.closed += rep.completed + rep.defaulted;
    t.defaulted += rep.defaulted;
    tallies.set(driver, t);
  }
  return [...tallies.values()]
    .map((t) => ({ ...t, rate: t.closed === 0 ? null : t.defaulted / t.closed }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
}

/** The model for an LLM company, the strategy for a bot. */
export function driverLabel(state: RunState, company: CompanyId): string {
  const entry = state.config.population.find((p) => p.id === company);
  if (entry === undefined) return '';
  return entry.driver.kind === 'llm' ? entry.driver.model : entry.driver.strategy;
}

/** Events a company took part in: as actor, as a contract party, or as a message recipient. */
export function timeline(log: Log, state: RunState, company: CompanyId): Event[] {
  const mine = new Set<string>(
    Object.values(state.contracts)
      .filter((k) => k.proposer === company || k.counterparty === company)
      .map((k) => k.id),
  );
  return log.rest.filter((e) => {
    if (e.actor === company) return true;
    if (e.type === 'dm_sent' && e.payload.to === company) return true;
    if (e.type === 'transfer_made' && e.payload.to === company) return true;
    if (e.type === 'license_auctioned' && e.payload.result.kind === 'sold') {
      return e.payload.result.winner === company;
    }
    if ('contract' in e.payload && typeof e.payload.contract === 'string') {
      return mine.has(e.payload.contract);
    }
    return false;
  });
}

export function companyRows(state: RunState) {
  return Object.values(state.companies)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => ({
      company: c,
      score: scoreOf(state, c),
      reputation: reputationOf(state, c),
      strategy: driverLabel(state, c.id),
    }));
}

/** A one-line description of an event for the timeline. */
export function describe(event: Event): string {
  switch (event.type) {
    case 'action_submitted':
      return `submitted ${event.payload.action.type}`;
    case 'action_rejected':
      return `rejected ${event.payload.action.type}: ${event.payload.code}, ${event.payload.reason}`;
    case 'contract_proposed':
      return `proposed ${event.payload.contract} to ${event.payload.counterparty}`;
    case 'contract_accepted':
      return `accepted ${event.payload.contract}`;
    case 'contract_rejected':
      return `rejected ${event.payload.contract}`;
    case 'contract_withdrawn':
      return `withdrew ${event.payload.contract}`;
    case 'contract_expired':
      return `${event.payload.contract} expired`;
    case 'escrow_deposited':
      return `deposited ${event.payload.units} on ${event.payload.contract}`;
    case 'escrow_released':
      return `${event.payload.contract} released to both sides`;
    case 'escrow_refunded':
      return `${event.payload.party} refunded on ${event.payload.contract}`;
    case 'escrow_forfeited':
      return `${event.payload.party} forfeited deposits on ${event.payload.contract}`;
    case 'penalty_charged':
      return `${event.payload.party} charged ${event.payload.amount} on ${event.payload.contract}`;
    case 'contract_completed':
      return `${event.payload.contract} completed`;
    case 'contract_defaulted':
      return `${event.payload.contract} defaulted by ${event.payload.by.join(' and ')} for ${event.payload.unmet_value}`;
    case 'transfer_made':
      return `transferred ${event.payload.what.kind === 'cash' ? `${event.payload.what.amount} cash` : `${event.payload.what.qty} ${event.payload.what.good}`} to ${event.payload.to}`;
    case 'message_posted':
      return `posted: ${event.payload.text}`;
    case 'dm_sent':
      return `to ${event.payload.to}: ${event.payload.text}`;
    case 'extraction_completed':
      return `extracted ${event.payload.qty} ${event.payload.good}`;
    case 'production_completed':
      return `produced ${event.payload.qty} ${event.payload.good}`;
    case 'npc_market_cleared':
      return `${event.payload.good} cleared ${event.payload.qty} at ${event.payload.price}`;
    case 'scrap_sold':
      return `scrapped ${event.payload.qty} ${event.payload.good} for ${event.payload.proceeds}`;
    case 'upkeep_charged':
      return `upkeep ${event.payload.amount}`;
    case 'storage_charged':
      return `storage ${event.payload.amount} for ${event.payload.units} units`;
    case 'company_bankrupt':
      return `bankrupt at ${event.payload.cash} cash`;
    case 'license_bought':
      return `bought ${event.payload.role} license for ${event.payload.price}`;
    case 'license_auctioned':
      return event.payload.result.kind === 'sold'
        ? `${event.payload.role} license sold to ${event.payload.result.winner} for ${event.payload.result.bid}`
        : `${event.payload.role} license unsold`;
    case 'company_rebranded':
      return `rebranded ${event.payload.old_name} to ${event.payload.new_name}`;
    case 'shock_applied':
      return `shock ${event.payload.shock.kind}`;
    case 'grove_regrew':
      return `${event.payload.grove} regrew to ${event.payload.stock}`;
    case 'bug_report_filed':
      return `bug report: ${event.payload.text}`;
    case 'agent_replaced_by_bot':
      return `replaced by ${event.payload.strategy} bot: ${event.payload.reason}`;
    case 'agent_trace_recorded':
      return `trace ${event.payload.trace_id}`;
    case 'run_started':
    case 'round_opened':
    case 'round_resolved':
    case 'turn_closed':
    case 'run_paused':
    case 'run_resumed':
    case 'run_ended':
      return event.type.replace('_', ' ');
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** Public and private message counts per turn, from the state's message list. */
export function messageRows(
  state: RunState,
  turns: number[],
): { turn: number; public: number; dm: number }[] {
  return turns.map((turn) => ({
    turn,
    public: state.messages.filter((m) => m.turn === turn && m.channel.kind === 'public').length,
    dm: state.messages.filter((m) => m.turn === turn && m.channel.kind === 'dm').length,
  }));
}

// The trade network: one edge per pair of companies that accepted a contract or exchanged DMs.

export type TradeEdge = {
  a: CompanyId;
  b: CompanyId;
  /** Accepted contracts between the pair, whatever their status now. */
  contracts: number;
  /** Reference value of those contracts, both sides. */
  value: number;
  completed: number;
  defaulted: number;
  dms: number;
};

export type EdgeFilter = {
  status: 'all' | 'completed' | 'defaulted' | 'active';
  good: Good | 'all';
};

const pairKey = (x: CompanyId, y: CompanyId): string => (x < y ? `${x}|${y}` : `${y}|${x}`);

/** Accepted contracts matching the filter. */
export function acceptedContracts(state: RunState, filter: EdgeFilter): Contract[] {
  return Object.values(state.contracts).filter((k) => {
    const { status } = k.status;
    if (status !== 'active' && status !== 'completed' && status !== 'defaulted') return false;
    if (filter.status !== 'all' && status !== filter.status) return false;
    if (
      filter.good !== 'all' &&
      !k.obligations.some((o) => o.kind === 'goods' && o.good === filter.good)
    ) {
      return false;
    }
    return true;
  });
}

export function tradeEdges(state: RunState, filter: EdgeFilter): TradeEdge[] {
  const edges = new Map<string, TradeEdge>();
  const edge = (x: CompanyId, y: CompanyId): TradeEdge => {
    const key = pairKey(x, y);
    const found = edges.get(key);
    if (found !== undefined) return found;
    const made: TradeEdge = {
      a: x < y ? x : y,
      b: x < y ? y : x,
      contracts: 0,
      value: 0,
      completed: 0,
      defaulted: 0,
      dms: 0,
    };
    edges.set(key, made);
    return made;
  };
  for (const k of acceptedContracts(state, filter)) {
    const e = edge(k.proposer, k.counterparty);
    e.contracts += 1;
    e.value += contractValue(state, k.obligations);
    if (k.status.status === 'completed') e.completed += 1;
    if (k.status.status === 'defaulted') e.defaulted += 1;
  }
  // DM-only edges show who talked without trading; a filtered view is about contracts only.
  if (filter.status === 'all' && filter.good === 'all') {
    for (const m of state.messages) {
      if (m.channel.kind === 'dm' && m.channel.to !== m.from) edge(m.from, m.channel.to).dms += 1;
    }
  }
  return [...edges.values()];
}
