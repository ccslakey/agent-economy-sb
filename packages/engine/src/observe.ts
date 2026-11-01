import {
  type Company,
  type CompanyId,
  type ContractId,
  FINAL_GOODS,
  type FinalGood,
  GOODS,
  type Good,
  type Message,
  type Observation,
  type Reputation,
  ROLES,
  type RunState,
  recipeOf,
} from '@agent-economy/schema';
import { capacityOf, reputationOf, scoreOf } from './world.ts';

/** What the API learned from the last round resolution, so the agent sees only what is new. */
export type RoundNews = {
  contracts_changed: readonly ContractId[];
  messages: readonly Message[];
};

/**
 * The per-company view for GET /v1/observation. Pure over state plus the news the API collected
 * at the last resolution. Only valid while a round is open; the API refuses otherwise.
 */
export function observe(
  state: RunState,
  company: Company,
  news: RoundNews,
  toolCallsLeft: number,
): Observation {
  if (state.phase.kind !== 'round')
    throw new Error(`no round is open in phase ${state.phase.kind}`);
  const { knobs, population } = state.config;
  const horizon = knobs.horizon;
  const solvent = Object.values(state.companies)
    .filter((c) => c.standing.kind === 'solvent')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const modelOf = (id: CompanyId): string | null => {
    if (knobs.model_identity !== 'visible') return null;
    const entry = population.find((p) => p.id === id);
    return entry?.driver.kind === 'llm' ? entry.driver.model : (entry?.driver.strategy ?? null);
  };

  const capacity: Partial<Record<Good, number>> = {};
  for (const good of GOODS) {
    const units = capacityOf(state, company, good);
    if (units > 0) capacity[good] = units;
  }

  const lastTurn: Partial<Record<FinalGood, { qty: number; price: number }>> = {};
  const ownSales: Partial<Record<FinalGood, { qty: number; price: number; proceeds: number }>> = {};
  for (const good of FINAL_GOODS) {
    const clear = state.market.clears.findLast((c) => c.good === good && c.turn === state.turn - 1);
    if (clear === undefined) continue;
    lastTurn[good] = { qty: clear.qty, price: clear.price };
    const sold = clear.sales[company.id];
    if (sold !== undefined)
      ownSales[good] = { qty: sold, price: clear.price, proceeds: sold * clear.price };
  }
  const recipes: Partial<Record<Good, Partial<Record<Good, number>>>> = {};
  for (const role of company.roles)
    recipes[ROLES[role].output] = { ...recipeOf(ROLES[role].output) };

  const mine = Object.values(state.contracts)
    .filter((k) => k.proposer === company.id || k.counterparty === company.id)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    turn: state.turn,
    round: state.phase.round,
    horizon:
      horizon.kind === 'fixed'
        ? { kind: 'fixed', last_turn: horizon.last_turn }
        : { kind: 'random', min_turns: horizon.min_turns, hazard: horizon.hazard },
    you: {
      id: company.id,
      name: company.name,
      roles: [...company.roles],
      cash: company.cash,
      inventory: company.inventory,
      capacity,
      pending_orders: company.pending_orders,
      recipes,
      net_worth: scoreOf(state, company),
      last_turn_sales: ownSales,
      last_turn_charges:
        company.charges.turn === state.turn - 1
          ? {
              upkeep: company.charges.upkeep,
              storage: company.charges.storage,
              storage_units: company.charges.storage_units,
              income: company.charges.income,
            }
          : { upkeep: 0, storage: 0, storage_units: 0, income: 0 },
    },
    scrap_per_unit: scrapPerUnit(state),
    needs: knobs.needs_board === 'on' ? needsBoard(state, solvent) : null,
    reference_prices: state.config.economy.reference_prices,
    companies: solvent.map((c) => ({
      id: c.id,
      name: c.name,
      roles: [...c.roles],
      model: modelOf(c.id),
    })),
    groves: Object.values(state.groves)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((g) => ({ id: g.id, stock: g.stock })),
    market: { last_turn: lastTurn },
    contracts: {
      active: mine.filter((k) => k.status.status === 'active').map((k) => k.id),
      proposed_to_you: mine
        .filter((k) => k.status.status === 'proposed' && k.counterparty === company.id)
        .map((k) => k.id),
      proposed_by_you: mine
        .filter((k) => k.status.status === 'proposed' && k.proposer === company.id)
        .map((k) => k.id),
      changed_since_last_round: mine
        .filter((k) => news.contracts_changed.includes(k.id))
        .map((k) => k.id),
    },
    messages: {
      public: news.messages.filter((m) => m.channel.kind === 'public'),
      dms: news.messages.filter(
        (m) => m.channel.kind === 'dm' && (m.from === company.id || m.channel.to === company.id),
      ),
    },
    reputation: visibleReputation(state, company, solvent),
    round_budget: { tool_calls_left: toolCallsLeft },
  };
}

function scrapPerUnit(state: RunState): Record<Good, number> {
  const { reference_prices, scrap_fraction } = state.config.economy;
  const out: Partial<Record<Good, number>> = {};
  for (const good of GOODS) out[good] = reference_prices[good] * scrap_fraction;
  return out as Record<Good, number>;
}

/** Each company's input shortfall for one full turn at capacity, and the output it holds. */
function needsBoard(
  state: RunState,
  companies: readonly Company[],
): {
  id: CompanyId;
  wants: Partial<Record<Good, number>>;
  offers: Partial<Record<Good, number>>;
}[] {
  return companies.map((c) => {
    const wants: Partial<Record<Good, number>> = {};
    const offers: Partial<Record<Good, number>> = {};
    for (const role of c.roles) {
      const output = ROLES[role].output;
      const capacity = capacityOf(state, c, output);
      for (const input of GOODS) {
        const perUnit = recipeOf(output)[input];
        if (perUnit === undefined) continue;
        const short = capacity * perUnit - (c.inventory[input] ?? 0);
        if (short > 0) wants[input] = (wants[input] ?? 0) + short;
      }
      const held = c.inventory[output] ?? 0;
      if (held > 0) offers[output] = held;
    }
    return { id: c.id, wants, offers };
  });
}

function visibleReputation(
  state: RunState,
  company: Company,
  solvent: readonly Company[],
): Partial<Record<CompanyId, Reputation>> | null {
  const knob = state.config.knobs.reputation_visibility;
  if (knob === 'hidden') return null;
  const asOf = knob === 'public_delayed' ? state.turn - 1 : state.turn;
  const shown = knob === 'own_only' ? [company] : solvent;
  const out: Partial<Record<CompanyId, Reputation>> = {};
  for (const c of shown) out[c.id] = reputationOf(state, c, asOf);
  return out;
}
