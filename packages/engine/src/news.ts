import type { ContractId, Event, Message } from '@agent-economy/schema';
import type { RoundNews } from './observe.ts';

/** What agents are told about at the next observation: contract ids touched and messages delivered. */
export function newsFrom(events: readonly Event[]): RoundNews {
  const contracts = new Set<ContractId>();
  const messages: Message[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'contract_proposed':
      case 'contract_accepted':
      case 'contract_rejected':
      case 'contract_withdrawn':
      case 'contract_expired':
      case 'escrow_deposited':
      case 'escrow_released':
      case 'escrow_refunded':
      case 'escrow_forfeited':
      case 'penalty_charged':
      case 'contract_completed':
      case 'contract_defaulted':
        contracts.add(e.payload.contract);
        break;
      default:
        break;
    }
    if (
      (e.type === 'message_posted' || e.type === 'dm_sent') &&
      e.actor !== null &&
      e.round !== null
    ) {
      messages.push({
        turn: e.turn,
        round: e.round,
        from: e.actor,
        channel: e.type === 'dm_sent' ? { kind: 'dm', to: e.payload.to } : { kind: 'public' },
        text: e.payload.text,
      });
    }
  }
  return { contracts_changed: [...contracts].sort(), messages };
}
