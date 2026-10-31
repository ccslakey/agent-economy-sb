import { z } from 'zod';
import { Action, ActionError } from './actions.ts';
import { BotStrategy, RunConfig } from './config.ts';
import { CompanyId, ContractId, EventId, GroveId, RunId } from './ids.ts';
import { keysOf, nonEmpty, taggedUnion } from './internal.ts';
import { ContractTerms, ObligationIndex, Party } from './state.ts';
import {
  Cash,
  ExtractedGood,
  ExtractSource,
  FinalGood,
  Good,
  Inventory,
  Qty,
  Role,
  Round,
  Shock,
  Turn,
} from './world.ts';

// The append-only log. One record of payload shapes is the source of truth for event types;
// the envelope matches the `events` table column for column so a row parses as an Event.
// Every payload is plain JSON: no Date, Map, undefined, or class instance anywhere below.

const Index = z.number().int().nonnegative();

export const eventShapes = {
  // lifecycle (actor: null)
  run_started: z.object({ config: RunConfig }),
  round_opened: z.object({}),
  round_resolved: z.object({}),
  turn_closed: z.object({}),
  run_paused: z.object({ reason: z.string() }),
  run_resumed: z.object({}),
  run_ended: z.object({
    reason: z.enum(['horizon_roll', 'fixed_last_turn', 'aborted']),
    scores: z.record(CompanyId, Cash),
  }),
  // actions (actor: the company)
  action_submitted: z.object({ index: Index, action: Action }),
  action_rejected: z.object({ index: Index, action: Action }).extend(ActionError.shape),
  // contracts (actor: the company whose action caused it; null when the engine did)
  contract_proposed: ContractTerms.extend({ contract: ContractId }),
  contract_accepted: z.object({ contract: ContractId, escrow_fee_per_side: Cash }),
  contract_rejected: z.object({ contract: ContractId }),
  contract_withdrawn: z.object({ contract: ContractId }),
  contract_expired: z.object({ contract: ContractId }),
  delivery_made: z.object({
    contract: ContractId,
    obligation: ObligationIndex,
    good: Good,
    qty: Qty,
  }),
  payment_made: z.object({ contract: ContractId, obligation: ObligationIndex, amount: Cash }),
  escrow_deposited: z.object({ contract: ContractId, obligation: ObligationIndex, units: Qty }),
  escrow_released: z.object({ contract: ContractId }),
  escrow_refunded: z.object({ contract: ContractId }),
  contract_completed: z.object({ contract: ContractId }),
  contract_defaulted: z.object({ contract: ContractId, by: nonEmpty(Party), unmet_value: Cash }),
  contract_cured: z.object({ contract: ContractId, cured_value: Cash }),
  // talk
  message_posted: z.object({ text: z.string() }),
  dm_sent: z.object({ to: CompanyId, text: z.string() }),
  // operations
  extraction_completed: z.object({ good: ExtractedGood, qty: Qty, from: ExtractSource }),
  production_completed: z.object({ good: Good, qty: Qty, consumed: Inventory }),
  npc_market_cleared: z.object({
    good: FinalGood,
    intercept: z.number(),
    qty: Qty,
    price: Cash,
    sales: z.partialRecord(CompanyId, Qty),
  }),
  scrap_sold: z.object({ good: Good, qty: Qty, proceeds: Cash }),
  upkeep_charged: z.object({ amount: Cash }),
  storage_charged: z.object({ units: Qty, amount: Cash }),
  // world
  grove_regrew: z.object({ grove: GroveId, stock: Qty }),
  shock_applied: z.object({ shock: Shock, until_turn: Turn }),
  company_bankrupt: z.object({
    cash: Cash,
    contracts_defaulted: z.array(ContractId),
    inventory_scrapped: Inventory,
  }),
  license_bought: z.object({ role: Role, price: Cash }),
  license_auctioned: z.object({
    role: Role,
    result: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('sold'), winner: CompanyId, bid: Cash }),
      z.object({ kind: z.literal('unsold') }),
    ]),
  }),
  company_rebranded: z.object({ old_name: z.string(), new_name: z.string(), fee: Cash }),
  // meta (recorded by the runner or API, no-ops in the fold)
  agent_trace_recorded: z.object({ trace_id: z.string() }),
  agent_replaced_by_bot: z.object({ strategy: BotStrategy, reason: z.string() }),
  bug_report_filed: z.object({ text: z.string() }),
} satisfies Record<string, z.ZodObject>;

export const Envelope = z.object({
  id: EventId,
  run_id: RunId,
  turn: Turn,
  /** null for the operations step and run-level events. */
  round: Round.nullable(),
  seq: z.number().int().nonnegative(),
  /** null when the engine or runner acted. */
  actor: CompanyId.nullable(),
});
export type Envelope = z.infer<typeof Envelope>;

type Enveloped<Shapes extends Record<string, z.ZodObject>> = {
  [K in keyof Shapes & string]: Envelope & { type: K; payload: z.infer<Shapes[K]> };
}[keyof Shapes & string];

export type Event = Enveloped<typeof eventShapes>;
export type EventType = Event['type'];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;
export type EventPayload<T extends EventType> = EventOf<T>['payload'];
export const EVENT_TYPES = keysOf(eventShapes);
export const Event = taggedUnion<Event, typeof eventShapes>(eventShapes, (type, shape) =>
  Envelope.extend({ type: z.literal(type), payload: shape }),
);
