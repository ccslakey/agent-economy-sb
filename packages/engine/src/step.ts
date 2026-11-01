import {
  type Action,
  type ActionError,
  type Company,
  type CompanyId,
  type Contract,
  type ContractId,
  contractId,
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
  type Obligation,
  type Party,
  PRODUCED_GOODS,
  producerOf,
  ROLE_NAMES,
  type Role,
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
import { capacityOf, demandFactor, partyOf, penaltyFor, remainingValue, scoreOf } from './world.ts';

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
      resolveQueue(current, emit);
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
  const caps = {
    post_message: s.config.limits.public_messages_per_round,
    send_dm: s.config.limits.dms_per_round,
  };
  const sent = { post_message: 0, send_dm: 0 };
  actions.forEach((action, index) => {
    let error = blocked ?? (c === undefined ? null : validate(s, c, action));
    if (error === null && (action.type === 'post_message' || action.type === 'send_dm')) {
      sent[action.type] += 1;
      if (sent[action.type] > caps[action.type]) {
        error = {
          code: 'MESSAGE_CAP_REACHED',
          reason: `${caps[action.type]} ${action.type} per round`,
        };
      }
    }
    if (error === null)
      emit({ type: 'action_submitted', payload: { index, action }, actor: company });
    else emit({ type: 'action_rejected', payload: { index, action, ...error }, actor: company });
  });
}

function counterpartyError(
  state: RunState,
  company: Company,
  other: CompanyId,
): ActionError | null {
  if (other === company.id) return { code: 'INVALID_ACTION', reason: 'that is you' };
  const target = state.companies[other];
  if (target === undefined || target.standing.kind === 'bankrupt') {
    return { code: 'INVALID_ACTION', reason: `no active company ${other}` };
  }
  return null;
}

function licenseError(company: Company, role: Role, price: number): ActionError | null {
  if (company.roles.includes(role)) {
    return { code: 'INVALID_ACTION', reason: `already licensed as ${role}` };
  }
  if (company.roles.length >= 2) {
    return { code: 'INVALID_ACTION', reason: 'one extra license per company' };
  }
  if (company.cash < price) {
    return { code: 'INSUFFICIENT_CASH', reason: `${company.id} has ${company.cash} cash` };
  }
  return null;
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
    case 'propose_contract': {
      const counterparty = state.companies[action.counterparty];
      if (action.counterparty === company.id) {
        return { code: 'INVALID_ACTION', reason: 'a contract needs two companies' };
      }
      if (counterparty === undefined || counterparty.standing.kind === 'bankrupt') {
        return { code: 'INVALID_ACTION', reason: `no active company ${action.counterparty}` };
      }
      const past = action.obligations.find((o) => o.due_turn < state.turn);
      if (past !== undefined) {
        return { code: 'INVALID_ACTION', reason: `due turn ${past.due_turn} has passed` };
      }
      return null;
    }
    case 'accept_contract':
    case 'reject_contract':
      return proposalError(state, company, action.contract, 'counterparty');
    case 'withdraw_contract':
      return proposalError(state, company, action.contract, 'proposer');
    case 'deliver':
      return fulfilmentError(
        state,
        company,
        action.contract,
        action.obligation,
        'goods',
        action.qty,
      );
    case 'pay':
      return fulfilmentError(
        state,
        company,
        action.contract,
        action.obligation,
        'cash',
        action.amount,
      );
    case 'post_message':
      return null;
    case 'send_dm':
      return counterpartyError(state, company, action.to);
    case 'transfer': {
      const error = counterpartyError(state, company, action.to);
      if (error !== null) return error;
      if (action.what.kind === 'cash' && company.cash < action.what.amount) {
        return { code: 'INSUFFICIENT_CASH', reason: `${company.id} has ${company.cash} cash` };
      }
      if (action.what.kind === 'goods') {
        const held = company.inventory[action.what.good] ?? 0;
        if (held < action.what.qty) {
          return {
            code: 'INSUFFICIENT_INVENTORY',
            reason: `${company.id} holds ${held} ${action.what.good}`,
          };
        }
      }
      return null;
    }
    case 'buy_license':
      return licenseError(company, action.role, state.config.economy.license_price);
    case 'bid_license': {
      const auction = state.auctions[action.role];
      if (auction === undefined || auction.closes_turn !== state.turn) {
        return { code: 'INVALID_ACTION', reason: `no ${action.role} license is up for auction` };
      }
      if (action.amount < auction.reserve) {
        return { code: 'INVALID_ACTION', reason: `the reserve is ${auction.reserve}` };
      }
      return licenseError(company, action.role, action.amount);
    }
    case 'rebrand':
      if (state.config.knobs.rebranding === 'off') {
        return { code: 'INVALID_ACTION', reason: 'rebranding is off in this run' };
      }
      if (company.cash < state.config.economy.rebrand_fee) {
        return {
          code: 'INSUFFICIENT_CASH',
          reason: `the rebrand fee is ${state.config.economy.rebrand_fee}`,
        };
      }
      return null;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function proposalError(
  state: RunState,
  company: Company,
  id: ContractId,
  mustBe: Party,
): ActionError | null {
  const contract = state.contracts[id];
  if (contract === undefined) return { code: 'CONTRACT_NOT_FOUND', reason: `no contract ${id}` };
  const side = partyOf(contract, company.id);
  if (side === null)
    return { code: 'NOT_A_PARTY', reason: `${company.id} is not a party to ${id}` };
  if (side !== mustBe) return { code: 'NOT_A_PARTY', reason: `only the ${mustBe} can do that` };
  if (contract.status.status !== 'proposed') {
    return { code: 'CONTRACT_NOT_ACTIVE', reason: `${id} is ${contract.status.status}` };
  }
  return null;
}

function fulfilmentError(
  state: RunState,
  company: Company,
  id: ContractId,
  index: number,
  kind: Obligation['kind'],
  units: number,
): ActionError | null {
  const contract = state.contracts[id];
  if (contract === undefined) return { code: 'CONTRACT_NOT_FOUND', reason: `no contract ${id}` };
  const side = partyOf(contract, company.id);
  if (side === null)
    return { code: 'NOT_A_PARTY', reason: `${company.id} is not a party to ${id}` };
  if (contract.status.status !== 'active') {
    return { code: 'CONTRACT_NOT_ACTIVE', reason: `${id} is ${contract.status.status}` };
  }
  const obligation = contract.obligations[index];
  if (obligation === undefined || obligation.kind !== kind) {
    return { code: 'INVALID_ACTION', reason: `${id} has no ${kind} obligation ${index}` };
  }
  if (obligation.by !== side) {
    return {
      code: 'INVALID_ACTION',
      reason: `obligation ${index} is owed by the ${obligation.by}`,
    };
  }
  const remaining =
    (obligation.kind === 'goods' ? obligation.qty : obligation.amount) - obligation.met;
  if (units > remaining) {
    return { code: 'INVALID_ACTION', reason: `only ${remaining} remaining on obligation ${index}` };
  }
  if (obligation.kind === 'goods' && (company.inventory[obligation.good] ?? 0) < units) {
    return {
      code: 'INSUFFICIENT_INVENTORY',
      reason: `${company.id} holds ${company.inventory[obligation.good] ?? 0} ${obligation.good}`,
    };
  }
  if (obligation.kind === 'cash' && company.cash < units) {
    return { code: 'INSUFFICIENT_CASH', reason: `${company.id} has ${company.cash} cash` };
  }
  return null;
}

// Round resolution: every queued action re-validates against the state as earlier actions in
// the same round left it, in company id then submission order, so a withdrawal and an
// acceptance in one round cannot both succeed.

function resolveQueue(current: () => RunState, emit: (body: Body) => void): void {
  const queue = [...current().pending_actions].sort((a, b) =>
    a.company < b.company ? -1 : a.company > b.company ? 1 : a.index - b.index,
  );
  for (const { company, index, action } of queue) {
    const s = current();
    const c = s.companies[company];
    if (c === undefined) continue;
    const error = validate(s, c, action);
    if (error !== null) {
      emit({ type: 'action_rejected', payload: { index, action, ...error }, actor: company });
      continue;
    }
    resolveAction(current, emit, c, action);
  }
}

function resolveAction(
  current: () => RunState,
  emit: (body: Body) => void,
  company: Company,
  action: Action,
): void {
  switch (action.type) {
    case 'propose_contract': {
      const { type: _, ...terms } = action;
      emit({
        type: 'contract_proposed',
        payload: {
          ...terms,
          proposer: company.id,
          contract: contractId(current().next_contract_no),
        },
        actor: company.id,
      });
      return;
    }
    case 'accept_contract':
      emit({
        type: 'contract_accepted',
        payload: { contract: action.contract },
        actor: company.id,
      });
      return;
    case 'reject_contract':
      emit({
        type: 'contract_rejected',
        payload: { contract: action.contract },
        actor: company.id,
      });
      return;
    case 'withdraw_contract':
      emit({
        type: 'contract_withdrawn',
        payload: { contract: action.contract },
        actor: company.id,
      });
      return;
    case 'deliver':
    case 'pay': {
      const contract = current().contracts[action.contract];
      const obligation = contract?.obligations[action.obligation];
      if (contract === undefined || obligation === undefined) return;
      const units = action.type === 'deliver' ? action.qty : action.amount;
      emit({
        type: 'escrow_deposited',
        payload: { contract: action.contract, obligation: action.obligation, units },
        actor: company.id,
      });
      settle(current, emit, action.contract);
      return;
    }
    case 'post_message':
      emit({ type: 'message_posted', payload: { text: action.text }, actor: company.id });
      return;
    case 'send_dm':
      emit({ type: 'dm_sent', payload: { to: action.to, text: action.text }, actor: company.id });
      return;
    case 'transfer':
      emit({
        type: 'transfer_made',
        payload: { to: action.to, what: action.what },
        actor: company.id,
      });
      return;
    case 'extract':
    case 'produce':
    case 'sell_npc':
    case 'scrap':
    case 'buy_license':
    case 'bid_license':
    case 'rebrand':
      return;
    default: {
      const _exhaustive: never = action;
      return;
    }
  }
}

/** After a deposit: when every obligation is in, release every deposit to its receiver and complete. */
function settle(current: () => RunState, emit: (body: Body) => void, id: ContractId): void {
  const s = current();
  const contract = s.contracts[id];
  if (contract === undefined || contract.status.status !== 'active') return;
  if (contract.obligations.some((o) => remainingValue(s, o) > 0)) return;
  emit({ type: 'escrow_released', payload: { contract: id }, actor: null });
  emit({ type: 'contract_completed', payload: { contract: id }, actor: null });
}

/**
 * Close an active contract as defaulted. A party that performed gets its deposits back. A
 * failing party loses its deposits and pays a share of its side's value as a penalty.
 */
function closeAsDefaulted(
  current: () => RunState,
  emit: (body: Body) => void,
  id: ContractId,
  failing: readonly Party[],
): void {
  const s = current();
  const contract = s.contracts[id];
  if (contract === undefined || contract.status.status !== 'active') return;
  const [first, ...rest] = failing;
  if (first === undefined) return;
  const unmetValue = contract.obligations
    .filter((o) => failing.includes(o.by))
    .reduce((sum, o) => sum + remainingValue(s, o), 0);
  const penalties = new Map<Party, number>();
  for (const party of ['proposer', 'counterparty'] as const) {
    if (failing.includes(party)) penalties.set(party, penaltyFor(s, contract, party));
  }
  for (const party of ['proposer', 'counterparty'] as const) {
    if (!failing.includes(party)) {
      emit({ type: 'escrow_refunded', payload: { contract: id, party }, actor: null });
      continue;
    }
    emit({ type: 'escrow_forfeited', payload: { contract: id, party }, actor: null });
    const amount = penalties.get(party) ?? 0;
    if (amount > 0) {
      emit({ type: 'penalty_charged', payload: { contract: id, party, amount }, actor: null });
    }
  }
  emit({
    type: 'contract_defaulted',
    payload: { contract: id, by: [first, ...rest], unmet_value: unmetValue },
    actor: null,
  });
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
  companyChanges(current, emit, rng);
  regrow(current, emit);
  shocks(current, emit, rng);
  contracts(current, emit);
  bankruptcy(current, emit);
  return endRoll(current, emit, rng);
}

/** License purchases, rebrands, and closing auctions, in company id order. */
function companyChanges(current: () => RunState, emit: (body: Body) => void, rng: Rng): void {
  for (const c of solvent(current())) {
    const { buy_license, rebrand } = c.pending_orders;
    const s = current();
    const price = s.config.economy.license_price;
    if (buy_license !== undefined && licenseError(c, buy_license, price) === null) {
      emit({ type: 'license_bought', payload: { role: buy_license, price }, actor: c.id });
    }
    const after = current().companies[c.id];
    const fee = s.config.economy.rebrand_fee;
    if (rebrand !== undefined && after !== undefined && after.cash >= fee) {
      emit({
        type: 'company_rebranded',
        payload: { old_name: c.name, new_name: rebrand, fee },
        actor: c.id,
      });
    }
  }
  const s = current();
  for (const role of ROLE_NAMES) {
    const auction = s.auctions[role];
    if (auction === undefined || auction.closes_turn !== s.turn) continue;
    const bids: { company: Company; amount: number }[] = [];
    for (const c of solvent(s)) {
      const amount = c.pending_orders.bids[role];
      if (amount === undefined || amount < auction.reserve) continue;
      if (licenseError(c, role, amount) !== null) continue;
      bids.push({ company: c, amount });
    }
    const top = Math.max(...bids.map((b) => b.amount));
    const tied = bids.filter((b) => b.amount === top);
    const winner = tied.length === 0 ? undefined : pick(rng, `auction_tie:${role}`, tied);
    emit({
      type: 'license_auctioned',
      payload: {
        role,
        result:
          winner === undefined
            ? { kind: 'unsold' }
            : { kind: 'sold', winner: winner.company.id, bid: winner.amount },
      },
      actor: null,
    });
  }
}

const byContractId = (a: Contract, b: Contract) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Expire stale proposals, then settle every active contract with an obligation still unmet at the end of its due turn. */
function contracts(current: () => RunState, emit: (body: Body) => void): void {
  const turn = current().turn;
  for (const contract of Object.values(current().contracts).sort(byContractId)) {
    if (contract.status.status === 'proposed' && contract.status.turn < turn) {
      emit({ type: 'contract_expired', payload: { contract: contract.id }, actor: null });
    }
  }
  for (const contract of Object.values(current().contracts).sort(byContractId)) {
    if (contract.status.status !== 'active') continue;
    const s = current();
    const due = contract.obligations.filter((o) => o.due_turn <= turn && remainingValue(s, o) > 0);
    if (due.length === 0) continue;
    const failing: Party[] = [];
    for (const o of due) if (!failing.includes(o.by)) failing.push(o.by);
    closeAsDefaulted(current, emit, contract.id, failing);
  }
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
    const involved = Object.values(current().contracts)
      .filter((k) => partyOf(k, c.id) !== null)
      .sort(byContractId);
    const active = involved.filter((k) => k.status.status === 'active');
    emit({
      type: 'company_bankrupt',
      payload: {
        cash: c.cash,
        contracts_defaulted: active.map((k) => k.id),
        inventory_scrapped: c.inventory,
      },
      actor: c.id,
    });
    for (const k of involved) {
      if (k.status.status === 'proposed') {
        emit({ type: 'contract_expired', payload: { contract: k.id }, actor: null });
      }
    }
    for (const k of active) {
      const side = partyOf(k, c.id);
      if (side !== null) closeAsDefaulted(current, emit, k.id, [side]);
    }
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
