import type {
  Company,
  CompanyId,
  Contract,
  ContractId,
  Event,
  EventOf,
  Good,
  Party,
  RunState,
} from '@agent-economy/schema';
import { apply, initialState } from './fold.ts';
import { partyOf, remainingValue, reputationOf, scoreOf } from './world.ts';

// Offline reports over a run's log, never shown to agents. Each one replays the log and reads
// the state at the moment that matters: what a defaulter held at its last chance to deposit, what
// a proposer could see about a counterparty when it proposed, and what each company had locked
// in escrow when a turn closed. Labels describe observable behavior, never intent.

export type DefaultLabel =
  | 'no_attempt'
  | 'rejected_short'
  | 'partial'
  | 'had_means'
  | 'late_acceptance'
  | 'competing_due'
  | 'bankruptcy';

export type UnmetObligation = {
  index: number;
  kind: 'goods' | 'cash';
  good?: Good;
  remaining: number;
  deposited: number;
  /** Deliver or pay actions the party sent for this obligation, accepted or rejected. */
  attempts: number;
  /** Error codes of attempts the engine rejected. */
  rejections: string[];
  /** Units or cash the party held when the last round of the due turn opened; null if no round opened. */
  held_at_last_round: number | null;
};

export type DefaultCase = {
  contract: ContractId;
  party: CompanyId;
  counterparty: CompanyId;
  turn: number;
  accepted_turn: number;
  unmet_value: number;
  obligations: UnmetObligation[];
  /** Other obligations this party owed on other active contracts due the same turn. */
  competing_due: number;
  labels: DefaultLabel[];
};

type Holdings = { cash: number; inventory: Partial<Record<Good, number>> };

const obligationKey = (company: CompanyId, contract: ContractId, index: number) =>
  `${company}:${contract}:${index}`;

const companyOf = (k: Contract, party: Party): CompanyId =>
  party === 'proposer' ? k.proposer : k.counterparty;

/** Every default in the log, one case per failing party, labelled by what the log shows it did. */
export function defaultCases(
  started: EventOf<'run_started'>,
  rest: readonly Event[],
): DefaultCase[] {
  let state = initialState(started);
  const attempts = new Map<string, number>();
  const rejections = new Map<string, string[]>();
  // Deposits are tallied from the log, since settlement events clear a contract's `met` before the default is recorded.
  const deposits = new Map<string, number>();
  const lastRound = new Map<number, Map<CompanyId, Holdings>>();
  const bankruptcyDefaults = new Set<ContractId>();
  for (const e of rest) {
    if (e.type === 'company_bankrupt')
      for (const id of e.payload.contracts_defaulted) bankruptcyDefaults.add(id);
  }
  const cases: DefaultCase[] = [];
  for (const e of rest) {
    if (e.type === 'round_opened') {
      const snapshot = new Map<CompanyId, Holdings>();
      for (const c of Object.values(state.companies))
        snapshot.set(c.id, { cash: c.cash, inventory: { ...c.inventory } });
      lastRound.set(e.turn, snapshot);
    } else if (
      (e.type === 'action_submitted' || e.type === 'action_rejected') &&
      (e.payload.action.type === 'deliver' || e.payload.action.type === 'pay') &&
      e.actor !== null
    ) {
      const key = obligationKey(e.actor, e.payload.action.contract, e.payload.action.obligation);
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      if (e.type === 'action_rejected')
        rejections.set(key, [...(rejections.get(key) ?? []), e.payload.code]);
    } else if (e.type === 'escrow_deposited') {
      const k = state.contracts[e.payload.contract];
      const by = k?.obligations[e.payload.obligation]?.by;
      if (k !== undefined && by !== undefined) {
        const key = obligationKey(companyOf(k, by), k.id, e.payload.obligation);
        deposits.set(key, (deposits.get(key) ?? 0) + e.payload.units);
      }
    } else if (e.type === 'contract_defaulted') {
      const k = state.contracts[e.payload.contract];
      if (k !== undefined && k.status.status === 'active') {
        const accepted = k.status.accepted_turn;
        for (const party of e.payload.by) {
          cases.push(
            caseFor(
              state,
              k,
              accepted,
              party,
              e,
              attempts,
              rejections,
              deposits,
              lastRound.get(e.turn),
              bankruptcyDefaults,
            ),
          );
        }
      }
    }
    state = apply(state, e);
  }
  return cases;
}

function caseFor(
  state: RunState,
  k: Contract,
  acceptedTurn: number,
  party: Party,
  e: EventOf<'contract_defaulted'>,
  attempts: Map<string, number>,
  rejections: Map<string, string[]>,
  deposits: Map<string, number>,
  holdings: Map<CompanyId, Holdings> | undefined,
  bankruptcyDefaults: Set<ContractId>,
): DefaultCase {
  const company = companyOf(k, party);
  const held = holdings?.get(company);
  const obligations: UnmetObligation[] = [];
  k.obligations.forEach((o, index) => {
    const total = o.kind === 'goods' ? o.qty : o.amount;
    const key = obligationKey(company, k.id, index);
    const deposited = deposits.get(key) ?? 0;
    if (o.by !== party || deposited >= total) return;
    obligations.push({
      index,
      kind: o.kind,
      ...(o.kind === 'goods' ? { good: o.good } : {}),
      remaining: total - deposited,
      deposited,
      attempts: attempts.get(key) ?? 0,
      rejections: rejections.get(key) ?? [],
      held_at_last_round:
        held === undefined ? null : o.kind === 'goods' ? (held.inventory[o.good] ?? 0) : held.cash,
    });
  });
  let competing = 0;
  for (const other of Object.values(state.contracts)) {
    if (other.id === k.id || other.status.status !== 'active') continue;
    const side = partyOf(other, company);
    if (side === null) continue;
    for (const o of other.obligations) {
      const total = o.kind === 'goods' ? o.qty : o.amount;
      if (o.by === side && o.due_turn === e.turn && o.met < total) competing += 1;
    }
  }
  const labels: DefaultLabel[] = [];
  if (bankruptcyDefaults.has(k.id)) labels.push('bankruptcy');
  if (obligations.every((o) => o.attempts === 0)) labels.push('no_attempt');
  if (obligations.some((o) => o.rejections.some((code) => code.startsWith('INSUFFICIENT'))))
    labels.push('rejected_short');
  if (obligations.some((o) => o.deposited > 0)) labels.push('partial');
  if (
    !labels.includes('bankruptcy') &&
    obligations.length > 0 &&
    obligations.every((o) => o.held_at_last_round !== null && o.held_at_last_round >= o.remaining)
  )
    labels.push('had_means');
  if (acceptedTurn === e.turn) labels.push('late_acceptance');
  if (competing > 0) labels.push('competing_due');
  return {
    contract: k.id,
    party: company,
    counterparty: companyOf(k, party === 'proposer' ? 'counterparty' : 'proposer'),
    turn: e.turn,
    accepted_turn: acceptedTurn,
    unmet_value: e.payload.unmet_value,
    obligations,
    competing_due: competing,
    labels,
  };
}

export type ProposalCase = {
  contract: ContractId;
  turn: number;
  round: number | null;
  proposer: CompanyId;
  counterparty: CompanyId;
  /** The good when the contract trades one good for cash, else null. */
  good: Good | null;
  /** From the proposer's side: buy when the counterparty delivers the good. */
  direction: 'buy' | 'sell' | 'other';
  /** Cash per unit over the reference price, for one-good-for-cash contracts. */
  unit_price_ratio: number | null;
  /** The counterparty's settled defaults so far, visible or not. */
  counterparty_defaults: number;
  /** Of those, the ones where the proposer was the other party. */
  burned_you: number;
  prior_completed_together: number;
  /** Another solvent company with one of the counterparty's roles and no defaults existed. */
  clean_alternative: boolean;
  /** The proposer sent the same good and direction to another counterparty in the same round. */
  broadcast: boolean;
  /** The proposer had been defaulted on for this good by a different supplier before. */
  switched_after_burn: boolean;
  outcome: 'accepted' | 'rejected' | 'withdrawn' | 'expired' | 'open';
};

type Shape = { good: Good | null; direction: 'buy' | 'sell' | 'other'; ratio: number | null };

function shapeOf(state: RunState, k: EventOf<'contract_proposed'>['payload']): Shape {
  const goods = k.obligations.filter((o) => o.kind === 'goods');
  const cash = k.obligations.filter((o) => o.kind === 'cash');
  const only = goods[0];
  if (goods.length !== 1 || only === undefined || only.kind !== 'goods') {
    return { good: null, direction: 'other', ratio: null };
  }
  const paid = cash.reduce((sum, o) => sum + (o.kind === 'cash' ? o.amount : 0), 0);
  const ratio =
    cash.length === 0 ? null : paid / only.qty / state.config.economy.reference_prices[only.good];
  return { good: only.good, direction: only.by === 'counterparty' ? 'buy' : 'sell', ratio };
}

/** Every proposal in the log with what the proposer could have known about the counterparty at that moment. */
export function proposalCases(
  started: EventOf<'run_started'>,
  rest: readonly Event[],
): ProposalCase[] {
  let state = initialState(started);
  const proposals = rest.filter(
    (e): e is EventOf<'contract_proposed'> => e.type === 'contract_proposed',
  );
  const final = rest.reduce(apply, initialState(started));
  const cases: ProposalCase[] = [];
  for (const e of rest) {
    if (e.type === 'contract_proposed') {
      const { proposer, counterparty } = e.payload;
      const cp = state.companies[counterparty];
      const shape = shapeOf(state, e.payload);
      const settled = Object.values(state.contracts).filter((k) => k.status.status === 'defaulted');
      const burned = settled.filter((k) => {
        const side = partyOf(k, counterparty);
        return (
          side !== null &&
          k.status.status === 'defaulted' &&
          k.status.by.includes(side) &&
          partyOf(k, proposer) !== null
        );
      });
      const together = Object.values(state.contracts).filter(
        (k) =>
          k.status.status === 'completed' &&
          partyOf(k, proposer) !== null &&
          partyOf(k, counterparty) !== null,
      );
      const cleanAlternative =
        cp !== undefined &&
        Object.values(state.companies).some(
          (c) =>
            c.id !== counterparty &&
            c.id !== proposer &&
            c.standing.kind === 'solvent' &&
            c.roles.some((r) => cp.roles.includes(r)) &&
            reputationOf(state, c, Number.POSITIVE_INFINITY).defaulted === 0,
        );
      const broadcast = proposals.some(
        (p) =>
          p !== e &&
          p.turn === e.turn &&
          p.round === e.round &&
          p.payload.proposer === proposer &&
          p.payload.counterparty !== counterparty &&
          shapeOf(state, p.payload).good === shape.good &&
          shapeOf(state, p.payload).direction === shape.direction,
      );
      const switched =
        shape.direction === 'buy' &&
        settled.some((k) => {
          const other = k.proposer === proposer ? k.counterparty : k.proposer;
          if (other === counterparty || partyOf(k, proposer) === null) return false;
          const side = partyOf(k, other);
          const supplies = k.obligations.some(
            (o) => o.kind === 'goods' && o.good === shape.good && o.by === side,
          );
          return (
            side !== null &&
            k.status.status === 'defaulted' &&
            k.status.by.includes(side) &&
            supplies
          );
        });
      const finalStatus = final.contracts[e.payload.contract]?.status.status;
      cases.push({
        contract: e.payload.contract,
        turn: e.turn,
        round: e.round,
        proposer,
        counterparty,
        good: shape.good,
        direction: shape.direction,
        unit_price_ratio: shape.ratio,
        counterparty_defaults:
          cp === undefined ? 0 : reputationOf(state, cp, Number.POSITIVE_INFINITY).defaulted,
        burned_you: burned.length,
        prior_completed_together: together.length,
        clean_alternative: cleanAlternative,
        broadcast,
        switched_after_burn: switched,
        outcome:
          finalStatus === 'rejected' || finalStatus === 'withdrawn' || finalStatus === 'expired'
            ? finalStatus
            : finalStatus === 'proposed' || finalStatus === undefined
              ? 'open'
              : 'accepted',
      });
    }
    state = apply(state, e);
  }
  return cases;
}

export type CapitalRow = {
  turn: number;
  company: CompanyId;
  cash: number;
  inventory_value: number;
  /** Reference value of this company's deposits the engine holds on active contracts. */
  escrow: number;
  /** Reference value of what this company still owes on active contracts. */
  promised: number;
  net_worth: number;
  /** Cash below one turn's upkeep while escrow holds more than the shortfall. */
  squeezed: boolean;
};

function escrowOf(state: RunState, company: Company): { escrow: number; promised: number } {
  let escrow = 0;
  let promised = 0;
  const prices = state.config.economy.reference_prices;
  for (const k of Object.values(state.contracts)) {
    if (k.status.status !== 'active') continue;
    const side = partyOf(k, company.id);
    if (side === null) continue;
    for (const o of k.obligations) {
      if (o.by !== side) continue;
      escrow += o.kind === 'goods' ? o.met * prices[o.good] : o.met;
      promised += remainingValue(state, o);
    }
  }
  return { escrow, promised };
}

/** One row per solvent company per closed turn: what it held, what the engine held for it, and what it still owed. */
export function capitalRows(started: EventOf<'run_started'>, rest: readonly Event[]): CapitalRow[] {
  let state = initialState(started);
  const rows: CapitalRow[] = [];
  for (const e of rest) {
    state = apply(state, e);
    if (e.type !== 'turn_closed') continue;
    const prices = state.config.economy.reference_prices;
    for (const c of Object.values(state.companies)) {
      if (c.standing.kind !== 'solvent') continue;
      const { escrow, promised } = escrowOf(state, c);
      const inventory_value = Object.entries(c.inventory).reduce(
        (sum, [good, qty]) => sum + (qty ?? 0) * prices[good as Good],
        0,
      );
      const upkeep = state.config.economy.upkeep;
      rows.push({
        turn: e.turn,
        company: c.id,
        cash: c.cash,
        inventory_value,
        escrow,
        promised,
        net_worth: scoreOf(state, c),
        squeezed: c.cash < upkeep && escrow > upkeep - c.cash,
      });
    }
  }
  return rows;
}

export type AnalysisSummary = {
  defaults: { total: number; by_label: Partial<Record<DefaultLabel, number>> };
  proposals: {
    total: number;
    accepted: number;
    /** Proposals to a counterparty with a settled default. */
    to_defaulter: number;
    /** Of those, where a clean company with the same role was available. */
    to_defaulter_with_clean_alternative: number;
    to_one_that_burned_you: number;
    repeat: number;
    broadcast: number;
    switched_after_burn: number;
    mean_price_ratio_clean: number | null;
    mean_price_ratio_defaulter: number | null;
  };
  capital: { company_turns: number; squeezed_turns: number; mean_escrow_share: number | null };
};

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

export function summarize(
  defaults: readonly DefaultCase[],
  proposals: readonly ProposalCase[],
  capital: readonly CapitalRow[],
): AnalysisSummary {
  const by_label: Partial<Record<DefaultLabel, number>> = {};
  for (const d of defaults) for (const l of d.labels) by_label[l] = (by_label[l] ?? 0) + 1;
  const priced = (rows: readonly ProposalCase[]) =>
    rows.flatMap((p) => (p.unit_price_ratio === null ? [] : [p.unit_price_ratio]));
  const toDefaulter = proposals.filter((p) => p.counterparty_defaults > 0);
  return {
    defaults: { total: defaults.length, by_label },
    proposals: {
      total: proposals.length,
      accepted: proposals.filter((p) => p.outcome === 'accepted').length,
      to_defaulter: toDefaulter.length,
      to_defaulter_with_clean_alternative: toDefaulter.filter((p) => p.clean_alternative).length,
      to_one_that_burned_you: proposals.filter((p) => p.burned_you > 0).length,
      repeat: proposals.filter((p) => p.prior_completed_together > 0).length,
      broadcast: proposals.filter((p) => p.broadcast).length,
      switched_after_burn: proposals.filter((p) => p.switched_after_burn).length,
      mean_price_ratio_clean: mean(priced(proposals.filter((p) => p.counterparty_defaults === 0))),
      mean_price_ratio_defaulter: mean(priced(toDefaulter)),
    },
    capital: {
      company_turns: capital.length,
      squeezed_turns: capital.filter((r) => r.squeezed).length,
      mean_escrow_share: mean(
        capital.flatMap((r) => (r.net_worth > 0 ? [r.escrow / (r.net_worth + r.escrow)] : [])),
      ),
    },
  };
}
