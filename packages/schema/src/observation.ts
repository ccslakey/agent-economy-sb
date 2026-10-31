import { z } from 'zod';
import { CompanyId, ContractId, GroveId } from './ids.ts';
import { Message, PendingOrders } from './state.ts';
import { Cash, FinalGood, Good, Inventory, Qty, Role, Round, Turn } from './world.ts';

// GET /v1/observation. A view computed by the engine from RunState for one company; never stored.
// Shapes follow the spec's example where it gives one.

/** Counts and values only. Agents decide what they mean. */
export const Reputation = z.object({
  completed: Qty,
  defaulted: Qty,
  cured: Qty,
  value_defaulted: Cash,
  value_cured: Cash,
});
export type Reputation = z.infer<typeof Reputation>;

export const Observation = z.object({
  turn: Turn,
  round: Round,
  min_turns: Turn,
  end_hazard: z.number(),
  you: z.object({
    id: CompanyId,
    name: z.string(),
    roles: z.array(Role),
    cash: Cash,
    inventory: Inventory,
    /** Per output good, after active shocks. Derived from ROLES, never stored. */
    capacity: z.partialRecord(Good, Qty),
    pending_orders: PendingOrders,
  }),
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
    proposed_to_you: z.array(ContractId),
    proposed_by_you: z.array(ContractId),
    changed_since_last_round: z.array(ContractId),
  }),
  messages: z.object({ public: z.array(Message), dms: z.array(Message) }),
  /** null when the reputation knob hides it; own entry only under `own_only`. */
  reputation: z.partialRecord(CompanyId, Reputation).nullable(),
  round_budget: z.object({ tool_calls_left: z.number().int().nonnegative() }),
});
export type Observation = z.infer<typeof Observation>;
