import {
  type Company,
  type CompanyId,
  type Contract,
  type FinalGood,
  GOODS,
  type Good,
  type Obligation,
  type Party,
  producerOf,
  type Reputation,
  ROLES,
  type RunState,
  SHOCK_RULES,
} from '@agent-economy/schema';

// Derived world facts. Nothing here is stored; each is arithmetic over state and the tables.

/** Units of `good` the company may order this turn, after licenses and active shocks. */
export function capacityOf(state: RunState, company: Company, good: Good): number {
  const role = producerOf(good);
  if (!company.roles.includes(role)) return 0;
  let capacity: number = ROLES[role].capacity;
  if (good === 'ore') {
    for (const active of state.shocks) {
      if (active.shock.kind === 'miners_strike') {
        capacity = Math.floor(capacity * SHOCK_RULES.miners_strike.factor);
      }
    }
  }
  return capacity;
}

/** Multiplier on a final good's demand intercept from active surges and slumps. */
export function demandFactor(state: RunState, good: FinalGood): number {
  let factor = 1;
  for (const active of state.shocks) {
    const { shock } = active;
    if ((shock.kind === 'demand_surge' || shock.kind === 'demand_slump') && shock.good === good) {
      factor *= SHOCK_RULES[shock.kind].factor;
    }
  }
  return factor;
}

/** Reference value of what an obligation still owes. */
export function remainingValue(state: RunState, obligation: Obligation): number {
  if (obligation.kind === 'cash') return obligation.amount - obligation.met;
  return (obligation.qty - obligation.met) * state.config.economy.reference_prices[obligation.good];
}

export function partyOf(contract: Contract, company: CompanyId): Party | null {
  if (contract.proposer === company) return 'proposer';
  if (contract.counterparty === company) return 'counterparty';
  return null;
}

/**
 * Derived from contracts, never stored. Counts closures from the company's current identity
 * onward and no later than `asOf`, which is how the public_delayed knob lags by a turn. Both
 * parties get credit for a completion. A cure counts as completed for the party that never
 * defaulted and as cured for the one that did.
 */
export function reputationOf(
  state: RunState,
  company: Company,
  asOf: number = state.turn,
): Reputation {
  const rep: Reputation = {
    completed: 0,
    defaulted: 0,
    cured: 0,
    value_defaulted: 0,
    value_cured: 0,
  };
  for (const contract of Object.values(state.contracts)) {
    const side = partyOf(contract, company.id);
    if (side === null) continue;
    const { status } = contract;
    if (
      status.status !== 'completed' &&
      status.status !== 'defaulted' &&
      status.status !== 'cured'
    ) {
      continue;
    }
    if (status.turn > asOf || status.turn < company.identity_since_turn) continue;
    if (status.status === 'completed') rep.completed += 1;
    else if (status.status === 'defaulted') {
      if (status.by.includes(side)) {
        rep.defaulted += 1;
        rep.value_defaulted += status.unmet_value;
      }
    } else if (status.defaulted_by.includes(side)) {
      rep.cured += 1;
      rep.value_cured += status.cured_value;
    } else rep.completed += 1;
  }
  return rep;
}

/** Net worth at the end of the game: cash plus inventory at the end inventory fraction of reference. A bankrupt company scores 0. */
export function scoreOf(state: RunState, company: Company): number {
  if (company.standing.kind === 'bankrupt') return 0;
  const { reference_prices, end_inventory_fraction } = state.config.economy;
  let inventoryValue = 0;
  for (const good of GOODS) {
    inventoryValue +=
      (company.inventory[good] ?? 0) * reference_prices[good] * end_inventory_fraction;
  }
  return company.cash + Math.floor(inventoryValue);
}
