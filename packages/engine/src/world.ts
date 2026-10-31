import {
  type Company,
  type FinalGood,
  GOODS,
  type Good,
  producerOf,
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
