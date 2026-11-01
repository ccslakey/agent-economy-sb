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

export const emptyOrders: PendingOrders = {
  extract: {},
  produce: {},
  sell_npc: {},
  scrap: {},
  bids: {},
};

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
      charges: { turn: 0, upkeep: 0, storage: 0, storage_units: 0 },
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
        case 'buy_license':
          return withCompany(marked, actor, (c) => ({
            ...c,
            pending_orders: { ...c.pending_orders, buy_license: action.role },
          }));
        case 'rebrand':
          return withCompany(marked, actor, (c) => ({
            ...c,
            pending_orders: { ...c.pending_orders, rebrand: action.name },
          }));
        case 'bid_license':
          return withCompany(marked, actor, (c) => ({
            ...c,
            pending_orders: {
              ...c.pending_orders,
              bids: { ...c.pending_orders.bids, [action.role]: action.amount },
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
          clears: [...next.market.clears, { turn: state.turn, good, qty, price, sales }],
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
    case 'upkeep_charged': {
      const { amount } = event.payload;
      return withCompany(state, actorOf(event), (c) => ({
        ...c,
        cash: c.cash - amount,
        charges: { turn: state.turn, upkeep: amount, storage: 0, storage_units: 0 },
      }));
    }
    case 'storage_charged': {
      const { amount, units } = event.payload;
      return withCompany(state, actorOf(event), (c) => ({
        ...c,
        cash: c.cash - amount,
        charges: {
          turn: state.turn,
          upkeep: c.charges.turn === state.turn ? c.charges.upkeep : 0,
          storage: amount,
          storage_units: units,
        },
      }));
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
    case 'company_bankrupt': {
      const actor = actorOf(event);
      const gone = state.companies[actor];
      if (gone === undefined) throw new Error(`unknown company ${actor}`);
      const auctions = { ...state.auctions };
      for (const role of gone.roles) {
        auctions[role] ??= {
          reserve: state.config.economy.license_reserve,
          closes_turn: state.turn + 1,
          bids: {},
        };
      }
      return withCompany({ ...state, auctions }, actor, (c) => ({
        ...c,
        inventory: {},
        standing: { kind: 'bankrupt', turn: state.turn },
      }));
    }

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
    case 'contract_accepted':
      return withContract(state, event.payload.contract, (k) => ({
        ...k,
        status: { status: 'active', accepted_turn: state.turn },
      }));
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
    case 'escrow_deposited': {
      const { contract: id, obligation: index, units } = event.payload;
      const depositor = actorOf(event);
      const obligation = contractOf(state, id).obligations[index];
      if (obligation === undefined) throw new Error(`${id} has no obligation ${index}`);
      const next = withContract(state, id, (c) => meet(c, index, units));
      return withCompany(next, depositor, (c) =>
        obligation.kind === 'goods'
          ? { ...c, inventory: addGoods(c.inventory, obligation.good, -units) }
          : { ...c, cash: c.cash - units },
      );
    }
    case 'escrow_released': {
      const contract = contractOf(state, event.payload.contract);
      let next = state;
      for (const o of contract.obligations) {
        const receiver = o.by === 'proposer' ? contract.counterparty : contract.proposer;
        next = withCompany(next, receiver, (c) =>
          o.kind === 'goods'
            ? { ...c, inventory: addGoods(c.inventory, o.good, o.met) }
            : { ...c, cash: c.cash + o.met },
        );
      }
      return next;
    }
    case 'escrow_refunded':
    case 'escrow_forfeited': {
      // A refund returns the party's deposits; a forfeit destroys them. Either way they leave the contract.
      const { contract: id, party } = event.payload;
      const contract = contractOf(state, id);
      const depositor = party === 'proposer' ? contract.proposer : contract.counterparty;
      let next = state;
      if (event.type === 'escrow_refunded') {
        for (const o of contract.obligations) {
          if (o.by !== party || o.met === 0) continue;
          next = withCompany(next, depositor, (c) =>
            o.kind === 'goods'
              ? { ...c, inventory: addGoods(c.inventory, o.good, o.met) }
              : { ...c, cash: c.cash + o.met },
          );
        }
      }
      return withContract(next, id, (c) => {
        const clear = <O extends Obligation>(o: O): O => (o.by === party ? { ...o, met: 0 } : o);
        const [first, ...rest] = c.obligations;
        return { ...c, obligations: [clear(first), ...rest.map(clear)] };
      });
    }
    case 'penalty_charged': {
      const { contract: id, party, amount } = event.payload;
      const contract = contractOf(state, id);
      const payer = party === 'proposer' ? contract.proposer : contract.counterparty;
      return withCompany(state, payer, (c) => ({ ...c, cash: c.cash - amount }));
    }
    case 'message_posted':
    case 'dm_sent': {
      const from = actorOf(event);
      const channel =
        event.type === 'dm_sent'
          ? ({ kind: 'dm', to: event.payload.to } as const)
          : ({ kind: 'public' } as const);
      return {
        ...state,
        messages: [
          ...state.messages,
          { turn: state.turn, round: event.round ?? 3, from, channel, text: event.payload.text },
        ],
      };
    }
    case 'transfer_made': {
      const { to, what } = event.payload;
      const from = actorOf(event);
      const move = (c: Company, sign: 1 | -1): Company =>
        what.kind === 'goods'
          ? { ...c, inventory: addGoods(c.inventory, what.good, sign * what.qty) }
          : { ...c, cash: c.cash + sign * what.amount };
      return withCompany(
        withCompany(state, from, (c) => move(c, -1)),
        to,
        (c) => move(c, 1),
      );
    }
    case 'license_bought': {
      const { role, price } = event.payload;
      return withCompany(state, actorOf(event), (c) => ({
        ...c,
        roles: [c.roles[0], ...c.roles.slice(1), role],
        cash: c.cash - price,
      }));
    }
    case 'license_auctioned': {
      const { role, result } = event.payload;
      const { [role]: _, ...auctions } = state.auctions;
      const next = { ...state, auctions };
      if (result.kind === 'unsold') return next;
      return withCompany(next, result.winner, (c) => ({
        ...c,
        roles: [c.roles[0], ...c.roles.slice(1), role],
        cash: c.cash - result.bid,
      }));
    }
    case 'company_rebranded': {
      const { new_name, fee } = event.payload;
      return withCompany(state, actorOf(event), (c) => ({
        ...c,
        name: new_name,
        cash: c.cash - fee,
        identity_since_turn: state.turn,
      }));
    }
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
