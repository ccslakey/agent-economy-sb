import { z } from 'zod';
import { GroveId } from './ids.ts';
import { keysOf } from './internal.ts';

// The production table. Roles, goods, recipes, capacities, and which goods the NPC buys all
// derive from this one object. Adding a good is one new row here and nothing else.

type RoleSpec = Readonly<
  { output: string; capacity: number; npc_market: boolean } & (
    | { verb: 'extract'; source: 'ore_pit' | 'grove'; inputs: Readonly<Record<never, number>> }
    | { verb: 'produce'; inputs: Readonly<Record<string, number>> }
  )
>;

export const ROLES = {
  miner: {
    verb: 'extract',
    source: 'ore_pit',
    inputs: {},
    output: 'ore',
    capacity: 12,
    npc_market: false,
  },
  logger: {
    verb: 'extract',
    source: 'grove',
    inputs: {},
    output: 'timber',
    capacity: 8,
    npc_market: false,
  },
  smelter: { verb: 'produce', inputs: { ore: 2 }, output: 'ingot', capacity: 6, npc_market: false },
  mill: { verb: 'produce', inputs: { timber: 1 }, output: 'plank', capacity: 6, npc_market: false },
  toolmaker: {
    verb: 'produce',
    inputs: { ingot: 2 },
    output: 'tool',
    capacity: 3,
    npc_market: true,
  },
  furniture_maker: {
    verb: 'produce',
    inputs: { plank: 3, tool: 1 },
    output: 'furniture',
    capacity: 2,
    npc_market: true,
  },
} as const satisfies Record<string, RoleSpec>;

type Roles = typeof ROLES;
export type Role = keyof Roles;
export type Good = Roles[Role]['output'];
type RolesWhere<P> = { [R in Role]: Roles[R] extends P ? R : never }[Role];
export type ExtractRole = RolesWhere<{ verb: 'extract' }>;
export type ProduceRole = RolesWhere<{ verb: 'produce' }>;
export type ExtractedGood = Roles[ExtractRole]['output'];
export type ProducedGood = Roles[ProduceRole]['output'];
export type FinalGood = Roles[RolesWhere<{ npc_market: true }>]['output'];

// Compile-time proof the chain is closed: every recipe input is some role's output.
type RecipeInputs = { [R in Role]: keyof Roles[R]['inputs'] }[Role];
const _recipesClosed: RecipeInputs extends Good ? true : never = true;

export const ROLE_NAMES = keysOf(ROLES);
export const GOODS: Good[] = ROLE_NAMES.map((r) => ROLES[r].output);
const isExtractRole = (r: Role): r is ExtractRole => ROLES[r].verb === 'extract';
const isProduceRole = (r: Role): r is ProduceRole => ROLES[r].verb === 'produce';
const isNpcRole = (r: Role): r is RolesWhere<{ npc_market: true }> => ROLES[r].npc_market;
export const EXTRACTED_GOODS: ExtractedGood[] = ROLE_NAMES.filter(isExtractRole).map(
  (r) => ROLES[r].output,
);
export const PRODUCED_GOODS: ProducedGood[] = ROLE_NAMES.filter(isProduceRole).map(
  (r) => ROLES[r].output,
);
export const FINAL_GOODS: FinalGood[] = ROLE_NAMES.filter(isNpcRole).map((r) => ROLES[r].output);

export const Role = z.enum(ROLE_NAMES);
export const Good = z.enum(GOODS);
export const ExtractedGood = z.enum(EXTRACTED_GOODS);
export const ProducedGood = z.enum(PRODUCED_GOODS);
export const FinalGood = z.enum(FINAL_GOODS);

/** The role that outputs a good. Goods are defined as role outputs, so the lookup always hits. */
export function producerOf(good: Good): Role {
  const role = ROLE_NAMES.find((r) => ROLES[r].output === good);
  if (role === undefined) throw new Error(`no role outputs ${good}`);
  return role;
}

// Domain primitives shared by config, state, actions, and events.

/** 0 is the pre-game turn `run_started` lands on; play starts at 1. */
export const Turn = z.number().int().nonnegative();
export type Turn = z.infer<typeof Turn>;
export const Round = z.literal([1, 2, 3]);
export type Round = z.infer<typeof Round>;
export const Qty = z.number().int().nonnegative();
export type Qty = z.infer<typeof Qty>;
/** Signed: a balance may sit below zero down to the overdraft limit. */
export const Cash = z.number().int();
export type Cash = z.infer<typeof Cash>;
/** Absent key means zero. Keeps inventories sparse on the wire. */
export const Inventory = z.partialRecord(Good, Qty);
export type Inventory = z.infer<typeof Inventory>;

/** Where an extract order pulls from. The good is implied: an ore pit yields ore, a grove timber. */
export const ExtractSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ore_pit') }),
  z.object({ kind: z.literal('grove'), grove: GroveId }),
]);
export type ExtractSource = z.infer<typeof ExtractSource>;
const _sourcesMatchTable: ExtractSource['kind'] extends Roles[ExtractRole]['source']
  ? true
  : never = true;

// Shocks. The union is the truth; the rule table is keyed by it so a new shock kind
// without a rule fails to compile.

export const Shock = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('grove_fire'), grove: GroveId }),
  z.object({ kind: z.literal('demand_surge'), good: FinalGood }),
  z.object({ kind: z.literal('demand_slump'), good: FinalGood }),
  z.object({ kind: z.literal('miners_strike') }),
]);
export type Shock = z.infer<typeof Shock>;

/** `factor` scales the shocked quantity (an intercept or a capacity); 0 turns means instant. */
export const SHOCK_RULES: Record<Shock['kind'], { duration_turns: number; factor: number }> = {
  grove_fire: { duration_turns: 0, factor: 0 },
  demand_surge: { duration_turns: 3, factor: 1.25 },
  demand_slump: { duration_turns: 3, factor: 0.75 },
  miners_strike: { duration_turns: 2, factor: 0.5 },
};
