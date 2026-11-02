import { z } from 'zod';
import { CompanyId, ContractId, GroveId } from './ids.ts';
import { Message, PendingOrders } from './state.ts';
import { Cash, FinalGood, Good, Inventory, Qty, Role, Round, Turn } from './world.ts';

/** Cash and goods held by the engine or still promised, summed over a company's active contracts. */
export const Holding = z.object({ cash: Cash, goods: Inventory });
export type Holding = z.infer<typeof Holding>;

/** One obligation on an active contract, seen from one company's side. */
export const ObligationView = z.object({
  contract: ContractId,
  /** Position in the contract's obligations, as `deliver` and `pay` name it. */
  obligation: z.number().int().nonnegative(),
  counterparty: CompanyId,
  direction: z.enum(['you_owe', 'owed_to_you']),
  kind: z.enum(['goods', 'cash']),
  good: Good.optional(),
  /** Units or cash still to deposit. Zero means this side is done. */
  remaining: z.number().nonnegative(),
  /** Units or cash already deposited with the engine. */
  deposited: z.number().nonnegative(),
  due_turn: Turn,
  /** Turns until the due turn ends. Zero means it must be in by the end of this turn. */
  turns_left: z.number().int(),
});
export type ObligationView = z.infer<typeof ObligationView>;

// GET /v1/observation. A view computed by the engine from RunState for one company; never stored.
// Shapes follow the spec's example where it gives one.

/** Counts and values only. Agents decide what they mean. */
export const Reputation = z.object({
  completed: Qty,
  defaulted: Qty,
  value_defaulted: Cash,
});
export type Reputation = z.infer<typeof Reputation>;

export const Observation = z.object({
  turn: Turn,
  round: Round,
  /** How the game ends: a known last turn, or a hazard that starts after a minimum. */
  horizon: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fixed'), last_turn: Turn }),
    z.object({ kind: z.literal('random'), min_turns: Turn, hazard: z.number() }),
  ]),
  you: z.object({
    id: CompanyId,
    name: z.string(),
    roles: z.array(Role),
    cash: Cash,
    inventory: Inventory,
    /** Per output good, after active shocks. Derived from ROLES, never stored. */
    capacity: z.partialRecord(Good, Qty),
    pending_orders: PendingOrders,
    /** Inputs per unit of each good this company can make. Empty for extracted goods. */
    recipes: z.partialRecord(Good, z.partialRecord(Good, Qty)),
    /** Cash plus inventory at the end-of-game valuation, as it stands now. */
    net_worth: Cash,
    /** What this company sold to the NPC last turn, and what it earned. */
    last_turn_sales: z.partialRecord(
      FinalGood,
      z.object({ qty: Qty, price: Cash, proceeds: Cash }),
    ),
    /** What last turn's operations step charged this company. */
    last_turn_charges: z.object({
      upkeep: Cash,
      storage: Cash,
      storage_units: Qty,
      income: Cash,
    }),
    /** Your deposits the engine holds on active contracts. `cash` and `inventory` above already exclude them. */
    in_escrow: Holding,
    /** What you have promised on active contracts and not yet deposited. */
    still_owed_by_you: Holding,
    /** What counterparties have promised you on active contracts and not yet deposited. */
    still_owed_to_you: Holding,
  }),
  /** The NPC buys any good as scrap at this price per unit, any quantity, in the operations step. */
  scrap_per_unit: z.record(Good, z.number()),
  /** With the needs_board knob on: each company's input shortfall for a full turn and the output it holds. Null when off. */
  needs: z
    .array(
      z.object({
        id: CompanyId,
        wants: z.partialRecord(Good, Qty),
        offers: z.partialRecord(Good, Qty),
      }),
    )
    .nullable(),
  /** The reference price of every good: the base for scrap, penalties, and the end inventory value. */
  reference_prices: z.record(Good, Cash),
  /** Everyone still in the game. `model` is null unless the model identity knob is `visible`. */
  companies: z.array(
    z.object({
      id: CompanyId,
      name: z.string(),
      roles: z.array(Role),
      model: z.string().nullable(),
    }),
  ),
  groves: z.array(z.object({ id: GroveId, stock: Qty })),
  market: z.object({ last_turn: z.partialRecord(FinalGood, z.object({ qty: Qty, price: Cash })) }),
  contracts: z.object({
    active: z.array(ContractId),
    /** Every obligation on your active contracts, from your side, soonest due first. */
    obligations: z.array(ObligationView),
    proposed_to_you: z.array(ContractId),
    proposed_by_you: z.array(ContractId),
    changed_since_last_round: z.array(ContractId),
  }),
  messages: z.object({ public: z.array(Message), dms: z.array(Message) }),
  /** null when the reputation knob hides it; own entry only under `own_only`. */
  reputation: z.partialRecord(CompanyId, Reputation).nullable(),
  round_budget: z.object({
    tool_calls_left: z.number().int().nonnegative(),
    /** Whether this round's batch is in: not yet, an empty batch, or a batch of actions. */
    submitted: z.enum(['none', 'empty', 'batch']),
  }),
});
export type Observation = z.infer<typeof Observation>;

/** An agent's standing plan, revised over the game. Each field is short prose. */
export const Plan = z.object({
  early: z.string().max(600),
  mid: z.string().max(600),
  late: z.string().max(600),
  /** What the agent is doing right now and why. */
  now: z.string().max(600),
  /** How the agent feels the game is going. Kept for the record, never interpreted. */
  thoughts: z.string().max(600),
});
export type Plan = z.infer<typeof Plan>;
