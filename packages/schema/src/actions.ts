import { z } from 'zod';
import { CompanyId, ContractId } from './ids.ts';
import { type Flat, keysOf, taggedUnion } from './internal.ts';
import { ContractTerms, ObligationIndex } from './state.ts';
import { Cash, ExtractSource, FinalGood, Good, ProducedGood, Qty, Role } from './world.ts';

// What an agent may put in one POST /v1/actions batch. The record below is the single source of
// truth for action types: the union, the type list, and the API docs all derive from it.

const Text = z.string().min(1).max(500);
const Transfer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('goods'), good: Good, qty: Qty.min(1) }),
  z.object({ kind: z.literal('cash'), amount: Cash.min(1) }),
]);

export const actionShapes = {
  post_message: z.object({ text: Text }),
  send_dm: z.object({ to: CompanyId, text: Text }),
  propose_contract: ContractTerms.omit({ proposer: true }),
  accept_contract: z.object({ contract: ContractId }),
  reject_contract: z.object({ contract: ContractId }),
  withdraw_contract: z.object({ contract: ContractId }),
  deliver: z.object({ contract: ContractId, obligation: ObligationIndex, qty: Qty.min(1) }),
  pay: z.object({ contract: ContractId, obligation: ObligationIndex, amount: Cash.min(1) }),
  transfer: z.object({ to: CompanyId, what: Transfer }),
  extract: z.object({ from: ExtractSource, qty: Qty.min(1) }),
  produce: z.object({ good: ProducedGood, qty: Qty.min(1) }),
  sell_npc: z.object({ good: FinalGood, qty: Qty.min(1) }),
  scrap: z.object({ good: Good, qty: Qty.min(1) }),
  buy_license: z.object({ role: Role }),
  bid_license: z.object({ role: Role, amount: Cash.min(1) }),
  rebrand: z.object({ name: z.string().min(1).max(40) }),
} satisfies Record<string, z.ZodObject>;

export type Action = Flat<typeof actionShapes>;
export type ActionType = Action['type'];
export const ACTION_TYPES = keysOf(actionShapes);
/** Strict: an unknown key is INVALID_ACTION, so a typo in an agent's payload is a visible error. */
export const Action = taggedUnion<Action, typeof actionShapes>(actionShapes, (type, shape) =>
  z.strictObject({ type: z.literal(type), ...shape.shape }),
);

export const ERROR_CODES = [
  'INSUFFICIENT_CASH',
  'INSUFFICIENT_INVENTORY',
  'CAPACITY_EXCEEDED',
  'NOT_LICENSED',
  'CONTRACT_NOT_FOUND',
  'CONTRACT_NOT_ACTIVE',
  'NOT_A_PARTY',
  'ROUND_CLOSED',
  'BATCH_ALREADY_SUBMITTED',
  'MESSAGE_CAP_REACHED',
  'NOTES_TOO_LONG',
  'INVALID_ACTION',
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ActionError = z.object({ code: ErrorCode, reason: z.string() });
export type ActionError = z.infer<typeof ActionError>;

/**
 * One per action, in batch order. Acceptance means the engine recorded `action_submitted`;
 * effects land when the round resolves and are visible next round.
 */
export const ActionResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false) }).extend(ActionError.shape),
]);
export type ActionResult = z.infer<typeof ActionResult>;

export type ParsedBatch = Array<{ ok: true; action: Action } | { ok: false; error: ActionError }>;

const Batch = z.object({ actions: z.array(z.unknown()) });

/**
 * The API boundary. Each element parses on its own so one malformed action never blocks the rest.
 * A body that is not `{ actions: [...] }` at all yields a single INVALID_ACTION entry.
 */
export function parseActionBatch(body: unknown): ParsedBatch {
  const batch = Batch.safeParse(body);
  if (!batch.success) {
    return [
      { ok: false, error: { code: 'INVALID_ACTION', reason: 'body must be { actions: [...] }' } },
    ];
  }
  return batch.data.actions.map((raw) => {
    const result = Action.safeParse(raw);
    return result.success
      ? { ok: true, action: result.data }
      : { ok: false, error: { code: 'INVALID_ACTION', reason: z.prettifyError(result.error) } };
  });
}
