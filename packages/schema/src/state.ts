import { z } from 'zod';
import { Action } from './actions.ts';
import { RunConfig } from './config.ts';
import { Contract } from './contracts.ts';
import { CompanyId, ContractId, GroveId, RunId } from './ids.ts';
import { nonEmpty } from './internal.ts';
import {
  Cash,
  ExtractedGood,
  ExtractSource,
  FinalGood,
  Good,
  Inventory,
  ProducedGood,
  Qty,
  Role,
  Round,
  Shock,
  Turn,
} from './world.ts';

// The fold's output. Everything here is reconstructed from events, so nothing in it is a source of
// truth, and nothing is stored that arithmetic over the rest can produce (capacity, reputation,
// net worth, contract value). Records are keyed by branded id because every engine access
// pattern is "the company, contract, or grove named by this id".

// Companies

/** Latest order per (kind, good) wins. Keyed by output good because capacity is per output good. */
export const PendingOrders = z.object({
  extract: z.partialRecord(ExtractedGood, z.object({ qty: Qty, from: ExtractSource })),
  produce: z.partialRecord(ProducedGood, Qty),
  sell_npc: z.partialRecord(FinalGood, Qty),
  scrap: z.partialRecord(Good, Qty),
});
export type PendingOrders = z.infer<typeof PendingOrders>;

export const Standing = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('solvent') }),
  z.object({ kind: z.literal('bankrupt'), turn: Turn }),
]);
export type Standing = z.infer<typeof Standing>;

export const Company = z.object({
  id: CompanyId,
  name: z.string().min(1),
  /** Reputation is derived from contracts closed at or after this turn; a rebrand bumps it. */
  identity_since_turn: Turn,
  roles: nonEmpty(Role),
  cash: Cash,
  inventory: Inventory,
  pending_orders: PendingOrders,
  standing: Standing,
});
export type Company = z.infer<typeof Company>;

// World

export const Grove = z.object({ id: GroveId, stock: Qty });
export type Grove = z.infer<typeof Grove>;

export const MarketClear = z.object({ turn: Turn, good: FinalGood, qty: Qty, price: Cash });
export type MarketClear = z.infer<typeof MarketClear>;

export const Channel = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('public') }),
  z.object({ kind: z.literal('dm'), to: CompanyId }),
]);
export type Channel = z.infer<typeof Channel>;

export const Message = z.object({
  turn: Turn,
  round: Round,
  from: CompanyId,
  channel: Channel,
  text: z.string(),
});
export type Message = z.infer<typeof Message>;

export const ActiveShock = z.object({ shock: Shock, until_turn: Turn });
export type ActiveShock = z.infer<typeof ActiveShock>;

/** A bankrupt company's license, open for `bid_license` during `closes_turn`. */
export const Auction = z.object({
  reserve: Cash,
  closes_turn: Turn,
  bids: z.partialRecord(CompanyId, Cash),
});
export type Auction = z.infer<typeof Auction>;

export const Phase = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('round'), round: Round }),
  z.object({ kind: z.literal('operations') }),
  z.object({ kind: z.literal('paused'), resume_to: Round }),
  z.object({ kind: z.literal('ended') }),
]);
export type Phase = z.infer<typeof Phase>;

/** A submitted action waiting for the round to resolve. Orders are not queued; they live in pending_orders. */
export const PendingAction = z.object({
  company: CompanyId,
  index: z.number().int().nonnegative(),
  action: Action,
});
export type PendingAction = z.infer<typeof PendingAction>;

export const RunState = z.object({
  run_id: RunId,
  config: RunConfig,
  turn: Turn,
  phase: Phase,
  /** Last event seq folded in. The engine numbers its next event `seq + 1`. */
  seq: z.number().int().nonnegative(),
  next_contract_no: z.number().int().positive(),
  /** Companies that have submitted this round. Cleared when the round resolves. */
  submitted: z.array(CompanyId),
  /** Submitted actions that take effect when the round resolves, in submission order. */
  pending_actions: z.array(PendingAction),
  companies: z.record(CompanyId, Company),
  groves: z.record(GroveId, Grove),
  contracts: z.record(ContractId, Contract),
  messages: z.array(Message),
  market: z.object({ intercept: z.record(FinalGood, z.number()), clears: z.array(MarketClear) }),
  shocks: z.array(ActiveShock),
  auctions: z.partialRecord(Role, Auction),
});
export type RunState = z.infer<typeof RunState>;
