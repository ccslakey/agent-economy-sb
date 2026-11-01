import { apply, initialState, reputationOf, scoreOf } from '@agent-economy/engine';
import type { Company, CompanyId, Event, EventOf, RunState } from '@agent-economy/schema';

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

export type CompanySnapshot = {
  turn: number;
  cash: number;
  inventory: Company['inventory'];
  score: number;
  standing: Company['standing']['kind'];
};

/** One row per turn for a company: cash, inventory, and score after that turn's operations. */
export function snapshots(log: Log, company: CompanyId): CompanySnapshot[] {
  const rows: CompanySnapshot[] = [];
  let state = initialState(log.started);
  let turn = state.turn;
  const push = (s: RunState) => {
    const c = s.companies[company];
    if (c === undefined) return;
    rows.push({
      turn,
      cash: c.cash,
      inventory: c.inventory,
      score: scoreOf(s, c),
      standing: c.standing.kind,
    });
  };
  for (const event of log.rest) {
    if (event.type === 'turn_closed' || event.type === 'run_ended') {
      state = apply(state, event);
      push(state);
      turn = state.turn;
      continue;
    }
    state = apply(state, event);
  }
  return rows;
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
      strategy: (() => {
        const entry = state.config.population.find((p) => p.id === c.id);
        return entry?.driver.kind === 'llm' ? entry.driver.model : (entry?.driver.strategy ?? '');
      })(),
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
    case 'delivery_made':
      return `delivered ${event.payload.qty} ${event.payload.good} on ${event.payload.contract}`;
    case 'payment_made':
      return `paid ${event.payload.amount} on ${event.payload.contract}`;
    case 'escrow_deposited':
      return `deposited ${event.payload.units} into escrow on ${event.payload.contract}`;
    case 'escrow_released':
      return `escrow released on ${event.payload.contract}`;
    case 'escrow_refunded':
      return `escrow refunded on ${event.payload.contract}`;
    case 'contract_completed':
      return `${event.payload.contract} completed`;
    case 'contract_defaulted':
      return `${event.payload.contract} defaulted by ${event.payload.by.join(' and ')} for ${event.payload.unmet_value}`;
    case 'contract_cured':
      return `${event.payload.contract} cured for ${event.payload.cured_value}`;
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
