import type { Event } from '@agent-economy/schema';

// One line per event, for timelines and for the digest a narrator reads.

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
