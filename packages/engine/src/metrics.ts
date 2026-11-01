import {
  type Event,
  type EventOf,
  FINAL_GOODS,
  type FinalGood,
  type Good,
  type Role,
  type RunState,
} from '@agent-economy/schema';
import { fold, initialState } from './fold.ts';
import { contractValue, partyOf, scoreOf } from './world.ts';

// The spec's run metrics, computed from a log and never shown to agents. Every number is a
// plain fold over events or arithmetic over the final state, so two runs compare like for like.

export type ContractCounts = {
  proposed: number;
  accepted: number;
  completed: number;
  defaulted: number;
};

export type RunMetrics = {
  turns: number;
  companies: number;
  bankruptcies: number;
  contracts: ContractCounts;
  /** Defaults over closures (completed plus defaulted), null before any closure. */
  default_rate: number | null;
  default_rate_by_role: Partial<Record<Role, number | null>>;
  /** Cash destroyed by penalties. */
  penalties: number;
  /** Reference value of every completed contract, both sides. */
  trade_value: number;
  /** Sum over companies of final net worth minus starting net worth. */
  welfare: number;
  /** Gini of final net worth, 0 when every company ends equal. */
  gini: number;
  messages: { public: number; dm: number };
  dm_share: number | null;
  /** Companies handed to a bot mid-run. A run with any is not a clean replicate. */
  bot_handoffs: number;
  /** Mean coefficient of variation of unit price across a turn's contracts for a good, null where no turn had two. */
  price_dispersion: Partial<Record<Good, number | null>>;
  npc_sales: Record<FinalGood, number>;
};

export function gini(values: readonly number[]): number {
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  const total = xs.reduce((sum, x) => sum + x, 0);
  if (n === 0 || total === 0) return 0;
  const weighted = xs.reduce((sum, x, i) => sum + (i + 1) * x, 0);
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

const rate = (hits: number, total: number): number | null => (total === 0 ? null : hits / total);

function priceDispersion(state: RunState): Partial<Record<Good, number | null>> {
  // Unit price is defined for a contract with one goods side and one cash side.
  const byGoodAndTurn = new Map<string, number[]>();
  for (const k of Object.values(state.contracts)) {
    if (k.status.status !== 'completed' && k.status.status !== 'active') continue;
    if (k.obligations.length !== 2) continue;
    const goods = k.obligations.find((o) => o.kind === 'goods');
    const cash = k.obligations.find((o) => o.kind === 'cash');
    if (goods === undefined || cash === undefined) continue;
    const key = `${goods.good}:${k.status.accepted_turn}`;
    byGoodAndTurn.set(key, [...(byGoodAndTurn.get(key) ?? []), cash.amount / goods.qty]);
  }
  const cvs = new Map<Good, number[]>();
  for (const [key, prices] of byGoodAndTurn) {
    if (prices.length < 2) continue;
    const good = key.slice(0, key.indexOf(':')) as Good;
    const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
    const sd = Math.sqrt(prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length);
    cvs.set(good, [...(cvs.get(good) ?? []), mean === 0 ? 0 : sd / mean]);
  }
  const out: Partial<Record<Good, number | null>> = {};
  for (const [good, list] of cvs) out[good] = list.reduce((s, c) => s + c, 0) / list.length;
  return out;
}

export function runMetrics(started: EventOf<'run_started'>, rest: readonly Event[]): RunMetrics {
  const first = initialState(started);
  const state = fold(started, rest);
  const contracts: ContractCounts = { proposed: 0, accepted: 0, completed: 0, defaulted: 0 };
  let penalties = 0;
  let bankruptcies = 0;
  let bot_handoffs = 0;
  const npc_sales = Object.fromEntries(FINAL_GOODS.map((g) => [g, 0])) as Record<FinalGood, number>;
  for (const e of rest) {
    if (e.type === 'contract_proposed') contracts.proposed += 1;
    else if (e.type === 'contract_accepted') contracts.accepted += 1;
    else if (e.type === 'contract_completed') contracts.completed += 1;
    else if (e.type === 'contract_defaulted') contracts.defaulted += 1;
    else if (e.type === 'penalty_charged') penalties += e.payload.amount;
    else if (e.type === 'company_bankrupt') bankruptcies += 1;
    else if (e.type === 'agent_replaced_by_bot') bot_handoffs += 1;
    else if (e.type === 'npc_market_cleared') npc_sales[e.payload.good] += e.payload.qty;
  }
  const closuresByRole = new Map<Role, { closed: number; defaulted: number }>();
  let trade_value = 0;
  for (const k of Object.values(state.contracts)) {
    const { status } = k;
    if (status.status !== 'completed' && status.status !== 'defaulted') continue;
    if (status.status === 'completed') trade_value += contractValue(state, k.obligations);
    for (const id of [k.proposer, k.counterparty]) {
      const company = state.companies[id];
      if (company === undefined) continue;
      const side = partyOf(k, id);
      const failed = status.status === 'defaulted' && side !== null && status.by.includes(side);
      for (const role of company.roles) {
        const tally = closuresByRole.get(role) ?? { closed: 0, defaulted: 0 };
        tally.closed += 1;
        if (failed) tally.defaulted += 1;
        closuresByRole.set(role, tally);
      }
    }
  }
  const default_rate_by_role: Partial<Record<Role, number | null>> = {};
  for (const [role, t] of closuresByRole) default_rate_by_role[role] = rate(t.defaulted, t.closed);
  const companies = Object.values(state.companies);
  const scores = companies.map((c) => scoreOf(state, c));
  const startingWorth = Object.values(first.companies).reduce(
    (sum, c) => sum + scoreOf(first, c),
    0,
  );
  const dm = state.messages.filter((m) => m.channel.kind === 'dm').length;
  const pub = state.messages.length - dm;
  return {
    turns: state.turn - (state.phase.kind === 'ended' ? 0 : 1),
    companies: companies.length,
    bankruptcies,
    contracts,
    default_rate: rate(contracts.defaulted, contracts.completed + contracts.defaulted),
    default_rate_by_role,
    penalties,
    trade_value,
    welfare: scores.reduce((sum, s) => sum + s, 0) - startingWorth,
    gini: gini(scores),
    messages: { public: pub, dm },
    dm_share: rate(dm, state.messages.length),
    bot_handoffs,
    price_dispersion: priceDispersion(state),
    npc_sales,
  };
}
