import { z } from 'zod';
import { RunConfig } from './config.ts';
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

// Contracts

/** Which side of the contract owes. The other side receives, so a third party cannot appear. */
export const Party = z.enum(['proposer', 'counterparty']);
export type Party = z.infer<typeof Party>;

const goodsTerms = z.object({
  kind: z.literal('goods'),
  by: Party,
  good: Good,
  qty: Qty.min(1),
  due_turn: Turn,
});
const cashTerms = z.object({
  kind: z.literal('cash'),
  by: Party,
  amount: Cash.min(1),
  due_turn: Turn,
});

/** As proposed. Each obligation has its own due turn, which is how a loan or a schedule is written. */
export const ObligationTerms = z.discriminatedUnion('kind', [goodsTerms, cashTerms]);
export type ObligationTerms = z.infer<typeof ObligationTerms>;

/** As it stands. `met` counts units delivered or paid, or deposited into escrow on an escrowed contract. */
export const Obligation = z.discriminatedUnion('kind', [
  goodsTerms.extend({ met: Qty }),
  cashTerms.extend({ met: Cash.nonnegative() }),
]);
export type Obligation = z.infer<typeof Obligation>;
/** Position in `obligations`. Agents name it in `deliver` and `pay`, events cite it. */
export const ObligationIndex = z.number().int().nonnegative();
export type ObligationIndex = z.infer<typeof ObligationIndex>;

export const ContractTerms = z.object({
  proposer: CompanyId,
  counterparty: CompanyId,
  obligations: nonEmpty(ObligationTerms),
  escrow: z.boolean(),
  /** Stored, never interpreted. */
  terms_text: z.string().max(2000),
});
export type ContractTerms = z.infer<typeof ContractTerms>;

/**
 * The lifecycle, one member per state, each carrying only the facts that state has.
 * proposed -> active | rejected | withdrawn | expired; active -> completed | defaulted;
 * defaulted -> cured. A late completion always passes through defaulted, because a default
 * fires the moment a due turn ends unmet.
 */
export const ContractStatus = z.discriminatedUnion('status', [
  z.object({ status: z.literal('proposed'), turn: Turn }),
  z.object({ status: z.literal('active'), accepted_turn: Turn }),
  z.object({ status: z.literal('rejected'), turn: Turn }),
  z.object({ status: z.literal('withdrawn'), turn: Turn }),
  z.object({ status: z.literal('expired'), turn: Turn }),
  z.object({ status: z.literal('completed'), accepted_turn: Turn, turn: Turn }),
  z.object({
    status: z.literal('defaulted'),
    accepted_turn: Turn,
    turn: Turn,
    by: nonEmpty(Party),
  }),
  z.object({
    status: z.literal('cured'),
    accepted_turn: Turn,
    defaulted_turn: Turn,
    defaulted_by: nonEmpty(Party),
    turn: Turn,
  }),
]);
export type ContractStatus = z.infer<typeof ContractStatus>;

export const Contract = ContractTerms.extend({
  id: ContractId,
  obligations: nonEmpty(Obligation),
  status: ContractStatus,
});
export type Contract = z.infer<typeof Contract>;

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
  companies: z.record(CompanyId, Company),
  groves: z.record(GroveId, Grove),
  contracts: z.record(ContractId, Contract),
  messages: z.array(Message),
  market: z.object({ intercept: z.record(FinalGood, z.number()), clears: z.array(MarketClear) }),
  shocks: z.array(ActiveShock),
  auctions: z.partialRecord(Role, Auction),
});
export type RunState = z.infer<typeof RunState>;
