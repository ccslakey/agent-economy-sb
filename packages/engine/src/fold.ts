import {
  type Company,
  type CompanyId,
  type Contract,
  type ContractId,
  demandFor,
  type Event,
  type EventOf,
  FINAL_GOODS,
  GOODS,
  type Good,
  type Grove,
  type GroveId,
  groveId,
  type Inventory,
  type Obligation,
  type PendingOrders,
  type RunState,
} from '@agent-economy/schema';

// The only way state changes. `step` produces events and folds each one through `apply` as it
// goes, so live play and replay reach state through this one path.

export const emptyOrders: PendingOrders = { extract: {}, produce: {}, sell_npc: {}, scrap: {} };

/** Build a full record from a key list. The one cast in this package: TypeScript cannot see that a loop over every key fills every key. */
function fromKeys<K extends string, V>(keys: readonly K[], value: (key: K) => V): Record<K, V> {
  const out: Partial<Record<K, V>> = {};
  for (const key of keys) out[key] = value(key);
  return out as Record<K, V>;
}

export function initialState(started: EventOf<'run_started'>): RunState {
  const { config } = started.payload;
  const companies: Record<CompanyId, Company> = {};
  for (const entry of config.population) {
    companies[entry.id] = {
      id: entry.id,
      name: entry.name,
      identity_since_turn: 0,
      roles: [entry.role],
      cash: config.economy.starting_cash,
      inventory: { ...config.economy.starting_inventory[entry.role] },
      pending_orders: emptyOrders,
      standing: { kind: 'solvent' },
    };
  }
  const groves: Record<GroveId, Grove> = {};
  for (let n = 1; n <= config.economy.groves.count; n++) {
    const id = groveId(n);
    groves[id] = { id, stock: config.economy.groves.stock_cap };
  }
  const demand = demandFor(config);
  return {
    run_id: started.run_id,
    config,
    turn: 1,
    phase: { kind: 'round', round: 1 },
    seq: started.seq,
    next_contract_no: 1,
    submitted: [],
    pending_actions: [],
    companies,
    groves,
    contracts: {},
    messages: [],
    market: { intercept: fromKeys(FINAL_GOODS, (good) => demand[good].a), clears: [] },
    shocks: [],
    auctions: {},
  };
}

/** Add `delta` units of `good`, dropping the key at zero so inventories stay sparse and comparable. */
export function addGoods(inventory: Inventory, good: Good, delta: number): Inventory {
  const next = (inventory[good] ?? 0) + delta;
  if (next < 0) throw new Error(`inventory of ${good} would go negative`);
  const { [good]: _, ...rest } = inventory;
  return next === 0 ? rest : { ...rest, [good]: next };
}

function withCompany(state: RunState, id: CompanyId, change: (c: Company) => Company): RunState {
  const company = state.companies[id];
  if (company === undefined) throw new Error(`unknown company ${id}`);
  return { ...state, companies: { ...state.companies, [id]: change(company) } };
}

function contractOf(state: RunState, id: ContractId): Contract {
  const contract = state.contracts[id];
  if (contract === undefined) throw new Error(`unknown contract ${id}`);
  return contract;
}

function withContract(
  state: RunState,
  id: ContractId,
  change: (k: Contract) => Contract,
): RunState {
  return { ...state, contracts: { ...state.contracts, [id]: change(contractOf(state, id)) } };
}

/** Record `units` toward one obligation, keeping the non-empty tuple shape. */
function meet(contract: Contract, index: number, units: number): Contract {
  const [first, ...rest] = contract.obligations;
  const bump = <O extends Obligation>(o: O, i: number): O =>
    i === index ? { ...o, met: o.met + units } : o;
  return { ...contract, obligations: [bump(first, 0), ...rest.map((o, i) => bump(o, i + 1))] };
}

function actorOf(event: Event): CompanyId {
  if (event.actor === null) throw new Error(`${event.type} needs an actor`);
  return event.actor;
}

function markSubmitted(state: RunState, company: CompanyId): RunState {
  return state.submitted.includes(company)
    ? state
    : { ...state, submitted: [...state.submitted, company] };
}

function applyBody(state: RunState, event: Event): RunState {
  switch (event.type) {
    case 'run_started':
    case 'round_opened':
      return state;
    case 'round_resolved':
      return {
        ...state,
        submitted: [],
        pending_actions: [],
        phase:
          event.round === null || event.round === 3
            ? { kind: 'operations' }
            : { kind: 'round', round: event.round === 1 ? 2 : 3 },
      };
    case 'turn_closed': {
      const companies: Record<CompanyId, Company> = {};
      for (const c of Object.values(state.companies)) {
        companies[c.id] = { ...c, pending_orders: emptyOrders };
      }
      const turn = state.turn + 1;
      return {
        ...state,
        companies,
        turn,
        phase: { kind: 'round', round: 1 },
        shocks: state.shocks.filter((active) => active.until_turn >= turn),
      };
    }
    case 'run_paused':
      return state.phase.kind === 'round'
        ? { ...state, phase: { kind: 'paused', resume_to: state.phase.round } }
        : state;
    case 'run_resumed':
      return state.phase.kind === 'paused'
        ? { ...state, phase: { kind: 'round', round: state.phase.resume_to } }
        : state;
    case 'run_ended':
      return { ...state, phase: { kind: 'ended' } };

    case 'action_submitted': {
      const actor = actorOf(event);
      const { action } = event.payload;
      const marked = markSubmitted(state, actor);
      switch (action.type) {
        case 'extract': {
          const good = action.from.kind === 'ore_pit' ? 'ore' : 'timber';
          return withCompany(marked, actor, (c) => ({
            ...c,
            pending_orders: {
              ...c.pending_orders,
              extract: {
                ...c.pending_orders.extract,
                [good]: { qty: action.qty, from: action.from },
              },
            },
          }));
        }
        case 'produce':
          return withCompany(marked, actor, (c) => ({
            ...c,
            pending_orders: {
              ...c.pending_orders,
              produce: { ...c.pending_orders.produce, [action.good]: action.qty },
            },
          }));
        case 'sell_npc':
          return withCompany(marked, actor, (c) => ({
            ...c,
            pending_orders: {
              ...c.pending_orders,
              sell_npc: { ...c.pending_orders.sell_npc, [action.good]: action.qty },
            },
          }));
        case 'scrap':
          return withCompany(marked, actor, (c) => ({
            ...c,
            pending_orders: {
              ...c.pending_orders,
              scrap: { ...c.pending_orders.scrap, [action.good]: action.qty },
            },
          }));
        default:
          return {
            ...marked,
            pending_actions: [
              ...marked.pending_actions,
              { company: actor, index: event.payload.index, action },
            ],
          };
      }
    }
    case 'action_rejected':
      return markSubmitted(state, actorOf(event));

    case 'extraction_completed': {
      const { good, qty, from } = event.payload;
      const next = withCompany(state, actorOf(event), (c) => ({
        ...c,
        inventory: addGoods(c.inventory, good, qty),
      }));
      if (from.kind !== 'grove') return next;
      const grove = next.groves[from.grove];
      if (grove === undefined) throw new Error(`unknown grove ${from.grove}`);
      return {
        ...next,
        groves: { ...next.groves, [from.grove]: { ...grove, stock: grove.stock - qty } },
      };
    }
    case 'production_completed': {
      const { good, qty, consumed } = event.payload;
      return withCompany(state, actorOf(event), (c) => {
        let inventory = addGoods(c.inventory, good, qty);
        for (const input of GOODS) {
          const units = consumed[input];
          if (units !== undefined) inventory = addGoods(inventory, input, -units);
        }
        return { ...c, inventory };
      });
    }
    case 'npc_market_cleared': {
      const { good, intercept, qty, price, sales } = event.payload;
      let next = state;
      for (const seller of Object.values(state.companies)) {
        const units = sales[seller.id];
        if (units === undefined) continue;
        next = withCompany(next, seller.id, (c) => ({
          ...c,
          cash: c.cash + units * price,
          inventory: addGoods(c.inventory, good, -units),
        }));
      }
      return {
        ...next,
        market: {
          intercept: { ...next.market.intercept, [good]: intercept },
          clears: [...next.market.clears, { turn: state.turn, good, qty, price }],
        },
      };
    }
    case 'scrap_sold': {
      const { good, qty, proceeds } = event.payload;
      return withCompany(state, actorOf(event), (c) => ({
        ...c,
        cash: c.cash + proceeds,
        inventory: addGoods(c.inventory, good, -qty),
      }));
    }
    case 'upkeep_charged':
    case 'storage_charged': {
      const { amount } = event.payload;
      return withCompany(state, actorOf(event), (c) => ({ ...c, cash: c.cash - amount }));
    }
    case 'grove_regrew': {
      const { grove, stock } = event.payload;
      const current = state.groves[grove];
      if (current === undefined) throw new Error(`unknown grove ${grove}`);
      return { ...state, groves: { ...state.groves, [grove]: { ...current, stock } } };
    }

    case 'shock_applied': {
      const { shock, until_turn } = event.payload;
      const next = { ...state, shocks: [...state.shocks, { shock, until_turn }] };
      if (shock.kind !== 'grove_fire') return next;
      const grove = next.groves[shock.grove];
      if (grove === undefined) throw new Error(`unknown grove ${shock.grove}`);
      return { ...next, groves: { ...next.groves, [shock.grove]: { ...grove, stock: 0 } } };
    }
    case 'company_bankrupt':
      return withCompany(state, actorOf(event), (c) => ({
        ...c,
        inventory: {},
        standing: { kind: 'bankrupt', turn: state.turn },
      }));

    case 'contract_proposed': {
      const { contract: id, ...terms } = event.payload;
      const [first, ...rest] = terms.obligations;
      const contract: Contract = {
        ...terms,
        id,
        obligations: [{ ...first, met: 0 }, ...rest.map((o) => ({ ...o, met: 0 }))],
        status: { status: 'proposed', turn: state.turn },
      };
      return {
        ...state,
        next_contract_no: state.next_contract_no + 1,
        contracts: { ...state.contracts, [id]: contract },
      };
    }
    case 'contract_accepted': {
      const { contract: id, escrow_fee_per_side } = event.payload;
      let next = withContract(state, id, (k) => ({
        ...k,
        status: { status: 'active', accepted_turn: state.turn },
      }));
      if (escrow_fee_per_side > 0) {
        const k = contractOf(state, id);
        for (const party of [k.proposer, k.counterparty]) {
          next = withCompany(next, party, (c) => ({ ...c, cash: c.cash - escrow_fee_per_side }));
        }
      }
      return next;
    }
    case 'contract_rejected':
      return withContract(state, event.payload.contract, (k) => ({
        ...k,
        status: { status: 'rejected', turn: state.turn },
      }));
    case 'contract_withdrawn':
      return withContract(state, event.payload.contract, (k) => ({
        ...k,
        status: { status: 'withdrawn', turn: state.turn },
      }));
    case 'contract_expired':
      return withContract(state, event.payload.contract, (k) => ({
        ...k,
        status: { status: 'expired', turn: state.turn },
      }));
    case 'delivery_made': {
      const { contract: id, obligation, good, qty } = event.payload;
      const from = actorOf(event);
      const k = contractOf(state, id);
      const to = k.proposer === from ? k.counterparty : k.proposer;
      let next = withContract(state, id, (c) => meet(c, obligation, qty));
      next = withCompany(next, from, (c) => ({
        ...c,
        inventory: addGoods(c.inventory, good, -qty),
      }));
      return withCompany(next, to, (c) => ({ ...c, inventory: addGoods(c.inventory, good, qty) }));
    }
    case 'payment_made': {
      const { contract: id, obligation, amount } = event.payload;
      const from = actorOf(event);
      const k = contractOf(state, id);
      const to = k.proposer === from ? k.counterparty : k.proposer;
      let next = withContract(state, id, (c) => meet(c, obligation, amount));
      next = withCompany(next, from, (c) => ({ ...c, cash: c.cash - amount }));
      return withCompany(next, to, (c) => ({ ...c, cash: c.cash + amount }));
    }
    case 'contract_completed':
      return withContract(state, event.payload.contract, (k) =>
        k.status.status === 'active'
          ? {
              ...k,
              status: {
                status: 'completed',
                accepted_turn: k.status.accepted_turn,
                turn: state.turn,
              },
            }
          : k,
      );
    case 'contract_defaulted': {
      const { contract: id, by, unmet_value } = event.payload;
      return withContract(state, id, (k) =>
        k.status.status === 'active'
          ? {
              ...k,
              status: {
                status: 'defaulted',
                accepted_turn: k.status.accepted_turn,
                turn: state.turn,
                by,
                unmet_value,
              },
            }
          : k,
      );
    }
    case 'contract_cured': {
      const { contract: id, cured_value } = event.payload;
      return withContract(state, id, (k) =>
        k.status.status === 'defaulted'
          ? {
              ...k,
              status: {
                status: 'cured',
                accepted_turn: k.status.accepted_turn,
                defaulted_turn: k.status.turn,
                defaulted_by: k.status.by,
                turn: state.turn,
                cured_value,
              },
            }
          : k,
      );
    }

    // Escrow, messages, and licenses (unit 5) fold here once that unit lands.
    case 'escrow_deposited':
    case 'escrow_released':
    case 'escrow_refunded':
    case 'message_posted':
    case 'dm_sent':
    case 'license_bought':
    case 'license_auctioned':
    case 'company_rebranded':
    case 'agent_trace_recorded':
    case 'agent_replaced_by_bot':
    case 'bug_report_filed':
      return state;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** Total over the union: the `never` default arm fails to compile when a type is added. */
export function apply(state: RunState, event: Event): RunState {
  return { ...applyBody(state, event), seq: event.seq };
}

export const fold = (started: EventOf<'run_started'>, rest: readonly Event[]): RunState =>
  rest.reduce(apply, initialState(started));
