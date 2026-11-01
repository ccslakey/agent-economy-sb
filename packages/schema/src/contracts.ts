import { z } from 'zod';
import { CompanyId, ContractId } from './ids.ts';
import { nonEmpty } from './internal.ts';
import { Cash, Good, Qty, Turn } from './world.ts';

// Contracts. The engine records them and never enforces them unless the enforcement knob says so.

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

/** As it stands. `met` counts units deposited with the engine toward this obligation. */
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
  /** Stored, never interpreted. */
  terms_text: z.string().max(2000),
});
export type ContractTerms = z.infer<typeof ContractTerms>;

/**
 * The lifecycle, one member per state, each carrying only the facts that state has.
 * proposed -> active | rejected | withdrawn | expired; active -> completed | defaulted.
 * Deposits are held by the engine. The contract completes when every obligation is deposited,
 * and settles as defaulted at the end of the first due turn an obligation is still unmet.
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
    /** Reference value of what was still owed when the default fired. */
    unmet_value: Cash,
  }),
]);
export type ContractStatus = z.infer<typeof ContractStatus>;

export const Contract = ContractTerms.extend({
  id: ContractId,
  obligations: nonEmpty(Obligation),
  status: ContractStatus,
});
export type Contract = z.infer<typeof Contract>;
