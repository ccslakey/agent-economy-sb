import {
  type Action,
  type ActionError,
  type Company,
  type CompanyId,
  demandFor,
  type Event,
  type EventOf,
  type EventPayload,
  type EventType,
  eventId,
  FINAL_GOODS,
  GOODS,
  type Good,
  type GroveId,
  PRODUCED_GOODS,
  producerOf,
  type RunConfig,
  type RunId,
  type RunState,
  recipeOf,
  SHOCK_KINDS,
  SHOCK_RULES,
  type Shock,
} from '@agent-economy/schema';
import { apply } from './fold.ts';
import type { Rng } from './rng.ts';
import { capacityOf, demandFactor, scoreOf } from './world.ts';

// state + input + rng -> events. Pure, no IO. The caller appends the events and folds them.

export type StepInput =
  | { kind: 'submit'; company: CompanyId; actions: readonly Action[] }
  | { kind: 'resolve_round' }
  | { kind: 'operations' };

type Body = {
  [K in EventType]: { type: K; payload: EventPayload<K>; actor: CompanyId | null };
}[EventType];

/** The first event of a run. `initialState` builds everything else from its payload. */
export function start(config: RunConfig, runId: RunId): EventOf<'run_started'> {
  return {
    id: eventId(runId, 0),
    run_id: runId,
    turn: 0,
    round: null,
    seq: 0,
    actor: null,
    type: 'run_started',
    payload: { config },
  };
}

export function step(state: RunState, input: StepInput, rng: Rng): Event[] {
  const out: Event[] = [];
  let s = state;
  const emit = (body: Body): void => {
    const seq = s.seq + 1;
    const event: Event = {
      id: eventId(s.run_id, seq),
      run_id: s.run_id,
      turn: s.turn,
      round: s.phase.kind === 'round' ? s.phase.round : null,
      seq,
      ...body,
    };
    out.push(event);
    s = apply(s, event);
  };
  const current = (): RunState => s;

  switch (input.kind) {
    case 'submit':
      submit(current, emit, input.company, input.actions);
      break;
    case 'resolve_round':
      if (s.phase.kind !== 'round')
        throw new Error(`cannot resolve a round in phase ${s.phase.kind}`);
      emit({ type: 'round_resolved', payload: {}, actor: null });
      if (s.phase.kind === 'round') emit({ type: 'round_opened', payload: {}, actor: null });
      break;
    case 'operations':
      if (s.phase.kind !== 'operations')
        throw new Error(`cannot run operations in phase ${s.phase.kind}`);
      if (!operations(current, emit, rng)) {
        emit({ type: 'turn_closed', payload: {}, actor: null });
        emit({ type: 'round_opened', payload: {}, actor: null });
      }
      break;
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
  return out;
}

// Submission: validate each action against the state at submit time and record it. Orders take
// effect in the operations step; everything else resolves at round end.

function submit(
  current: () => RunState,
  emit: (body: Body) => void,
  company: CompanyId,
  actions: readonly Action[],
): void {
  const s = current();
  const c = s.companies[company];
  const batchError = (): ActionError | null => {
    if (c === undefined) return { code: 'INVALID_ACTION', reason: `unknown company ${company}` };
    if (c.standing.kind === 'bankrupt') {
      return { code: 'INVALID_ACTION', reason: 'company is bankrupt' };
    }
    if (s.phase.kind !== 'round') return { code: 'ROUND_CLOSED', reason: 'no round is open' };
    if (s.submitted.includes(company)) {
      return { code: 'BATCH_ALREADY_SUBMITTED', reason: 'one batch per round' };
    }
    return null;
  };
  const blocked = batchError();
  actions.forEach((action, index) => {
    const error = blocked ?? (c === undefined ? null : validate(s, c, action));
    if (error === null)
      emit({ type: 'action_submitted', payload: { index, action }, actor: company });
    else emit({ type: 'action_rejected', payload: { index, action, ...error }, actor: company });
  });
}

function orderError(
  state: RunState,
  company: Company,
  good: Good,
  qty: number,
): ActionError | null {
  const role = producerOf(good);
  if (!company.roles.includes(role)) {
    return { code: 'NOT_LICENSED', reason: `${good} needs the ${role} license` };
  }
  const capacity = capacityOf(state, company, good);
  if (qty > capacity) {
    return { code: 'CAPACITY_EXCEEDED', reason: `${good} capacity is ${capacity} per turn` };
  }
  return null;
}

function validate(state: RunState, company: Company, action: Action): ActionError | null {
  switch (action.type) {
    case 'extract': {
      if (action.from.kind === 'grove' && state.groves[action.from.grove] === undefined) {
        return { code: 'INVALID_ACTION', reason: `no grove ${action.from.grove}` };
      }
      return orderError(
        state,
        company,
        action.from.kind === 'ore_pit' ? 'ore' : 'timber',
        action.qty,
      );
    }
    case 'produce':
      return orderError(state, company, action.good, action.qty);
    case 'sell_npc':
    case 'scrap':
      return null;
    case 'post_message':
    case 'send_dm':
    case 'propose_contract':
    case 'accept_contract':
    case 'reject_contract':
    case 'withdraw_contract':
    case 'deliver':
    case 'pay':
    case 'transfer':
    case 'buy_license':
    case 'bid_license':
    case 'rebrand':
      return { code: 'INVALID_ACTION', reason: `${action.type} is not available in this build` };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

// The operations step, in the spec's fixed order. Each phase reads the state as the previous
// phase left it, because `emit` folds every event before the next one is computed.

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function solvent(state: RunState): Company[] {
  return Object.values(state.companies)
    .filter((c) => c.standing.kind === 'solvent')
    .sort(byId);
}

/** Returns true when the run ended this turn, in which case no new turn opens. */
function operations(current: () => RunState, emit: (body: Body) => void, rng: Rng): boolean {
  extraction(current, emit);
  production(current, emit);
  market(current, emit, rng);
  scrap(current, emit);
  upkeep(current, emit);
  regrow(current, emit);
  shocks(current, emit, rng);
  bankruptcy(current, emit);
  return endRoll(current, emit, rng);
}

function regrow(current: () => RunState, emit: (body: Body) => void): void {
  const s = current();
  const { stock_cap, regrowth } = s.config.economy.groves;
  for (const grove of Object.values(s.groves).sort(byId)) {
    if (grove.stock >= stock_cap) continue;
    emit({
      type: 'grove_regrew',
      payload: { grove: grove.id, stock: Math.min(stock_cap, grove.stock + regrowth) },
      actor: null,
    });
  }
}

function pick<T>(rng: Rng, purpose: string, items: readonly T[]): T {
  const item = items[Math.floor(rng(purpose) * items.length)];
  if (item === undefined) throw new Error(`nothing to pick for ${purpose}`);
  return item;
}

function shocks(current: () => RunState, emit: (body: Body) => void, rng: Rng): void {
  const s = current();
  if (s.config.knobs.shocks === 'off') return;
  if (rng('shock_roll') >= s.config.economy.shock_chance) return;
  const kind = pick(rng, 'shock_kind', SHOCK_KINDS);
  emit({
    type: 'shock_applied',
    payload: {
      shock: drawShock(s, kind, rng),
      until_turn: s.turn + SHOCK_RULES[kind].duration_turns,
    },
    actor: null,
  });
}

function drawShock(state: RunState, kind: Shock['kind'], rng: Rng): Shock {
  switch (kind) {
    case 'grove_fire':
      return { kind, grove: pick(rng, 'shock_target', Object.values(state.groves).sort(byId)).id };
    case 'demand_surge':
    case 'demand_slump':
      return { kind, good: pick(rng, 'shock_target', FINAL_GOODS) };
    case 'miners_strike':
      return { kind };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function bankruptcy(current: () => RunState, emit: (body: Body) => void): void {
  const s = current();
  for (const c of solvent(s)) {
    if (c.cash >= s.config.economy.overdraft_limit) continue;
    emit({
      type: 'company_bankrupt',
      payload: { cash: c.cash, contracts_defaulted: [], inventory_scrapped: c.inventory },
      actor: c.id,
    });
  }
}

function endRoll(current: () => RunState, emit: (body: Body) => void, rng: Rng): boolean {
  const s = current();
  const { horizon } = s.config.knobs;
  const ends =
    horizon.kind === 'fixed'
      ? s.turn >= horizon.last_turn
      : s.turn >= horizon.min_turns && rng('end_roll') < horizon.hazard;
  if (!ends) return false;
  const scores: Record<CompanyId, number> = {};
  for (const c of Object.values(s.companies)) scores[c.id] = scoreOf(s, c);
  emit({
    type: 'run_ended',
    payload: { reason: horizon.kind === 'fixed' ? 'fixed_last_turn' : 'horizon_roll', scores },
    actor: null,
  });
  return true;
}

function extraction(current: () => RunState, emit: (body: Body) => void): void {
  const s = current();
  const groveRequests = new Map<GroveId, { company: CompanyId; qty: number }[]>();
  for (const c of solvent(s)) {
    const ore = c.pending_orders.extract.ore;
    if (ore !== undefined && ore.qty > 0) {
      emit({
        type: 'extraction_completed',
        payload: { good: 'ore', qty: ore.qty, from: ore.from },
        actor: c.id,
      });
    }
    const timber = c.pending_orders.extract.timber;
    if (timber !== undefined && timber.from.kind === 'grove' && timber.qty > 0) {
      const list = groveRequests.get(timber.from.grove) ?? [];
      list.push({ company: c.id, qty: timber.qty });
      groveRequests.set(timber.from.grove, list);
    }
  }
  for (const grove of Object.values(s.groves).sort(byId)) {
    const requests = groveRequests.get(grove.id);
    if (requests === undefined) continue;
    for (const share of proRata(grove.stock, requests)) {
      if (share.qty === 0) continue;
      emit({
        type: 'extraction_completed',
        payload: { good: 'timber', qty: share.qty, from: { kind: 'grove', grove: grove.id } },
        actor: share.company,
      });
    }
  }
}

/**
 * Split `stock` across requests. Everyone gets what they asked for when it fits. Otherwise each
 * gets the floor of its proportional share, and the leftover units go one each in company id order.
 */
export function proRata(
  stock: number,
  requests: readonly { company: CompanyId; qty: number }[],
): { company: CompanyId; qty: number }[] {
  const total = requests.reduce((sum, r) => sum + r.qty, 0);
  if (total <= stock) return [...requests];
  const ordered = [...requests].sort((a, b) => (a.company < b.company ? -1 : 1));
  const shares = ordered.map((r) => ({
    company: r.company,
    qty: Math.floor((stock * r.qty) / total),
  }));
  let leftover = stock - shares.reduce((sum, r) => sum + r.qty, 0);
  for (const share of shares) {
    if (leftover === 0) break;
    share.qty += 1;
    leftover -= 1;
  }
  return shares;
}

function production(current: () => RunState, emit: (body: Body) => void): void {
  for (const c of solvent(current())) {
    for (const good of PRODUCED_GOODS) {
      const ordered = c.pending_orders.produce[good];
      if (ordered === undefined || ordered === 0) continue;
      const recipe = recipeOf(good);
      const inventory = current().companies[c.id]?.inventory ?? {};
      let feasible = ordered;
      for (const input of GOODS) {
        const need = recipe[input];
        if (need !== undefined)
          feasible = Math.min(feasible, Math.floor((inventory[input] ?? 0) / need));
      }
      if (feasible === 0) continue;
      const consumed: Partial<Record<Good, number>> = {};
      for (const input of GOODS) {
        const need = recipe[input];
        if (need !== undefined) consumed[input] = need * feasible;
      }
      emit({
        type: 'production_completed',
        payload: { good, qty: feasible, consumed },
        actor: c.id,
      });
    }
  }
}

function market(current: () => RunState, emit: (body: Body) => void, rng: Rng): void {
  const s = current();
  const curves = demandFor(s.config);
  const { demand_noise, reference_prices, scrap_fraction } = s.config.economy;
  for (const good of FINAL_GOODS) {
    const sales: Partial<Record<CompanyId, number>> = {};
    let quantity = 0;
    for (const c of solvent(s)) {
      const wanted = c.pending_orders.sell_npc[good] ?? 0;
      const units = Math.min(wanted, c.inventory[good] ?? 0);
      if (units > 0) {
        sales[c.id] = units;
        quantity += units;
      }
    }
    const noise = (rng(`demand_noise:${good}`) * 2 - 1) * demand_noise;
    const intercept = curves[good].a * (1 + noise) * demandFactor(s, good);
    const floor = Math.floor(reference_prices[good] * scrap_fraction);
    const price = Math.max(floor, Math.floor(intercept - curves[good].b * quantity));
    emit({
      type: 'npc_market_cleared',
      payload: { good, intercept, qty: quantity, price, sales },
      actor: null,
    });
  }
}

function scrap(current: () => RunState, emit: (body: Body) => void): void {
  const { reference_prices, scrap_fraction } = current().config.economy;
  for (const c of solvent(current())) {
    for (const good of GOODS) {
      const wanted = c.pending_orders.scrap[good] ?? 0;
      const held = current().companies[c.id]?.inventory[good] ?? 0;
      const qty = Math.min(wanted, held);
      if (qty === 0) continue;
      const proceeds = Math.floor(qty * reference_prices[good] * scrap_fraction);
      emit({ type: 'scrap_sold', payload: { good, qty, proceeds }, actor: c.id });
    }
  }
}

function upkeep(current: () => RunState, emit: (body: Body) => void): void {
  const { upkeep: amount, storage_cost_per_unit } = current().config.economy;
  for (const c of solvent(current())) {
    emit({ type: 'upkeep_charged', payload: { amount }, actor: c.id });
    const units = Object.values(c.inventory).reduce((sum, n) => sum + (n ?? 0), 0);
    if (units > 0) {
      emit({
        type: 'storage_charged',
        payload: { units, amount: units * storage_cost_per_unit },
        actor: c.id,
      });
    }
  }
}
