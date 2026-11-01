import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  ACTION_TYPES,
  Action,
  type ActionType,
  demandFor,
  EVENT_TYPES,
  Event,
  type EventType,
  FINAL_GOODS,
  GOODS,
  parseActionBatch,
  producerOf,
  ROLE_NAMES,
  ROLES,
  RunConfig,
} from './index.ts';

// Unit 1's rerunnable check. Each test asserts a literal the spec states or a property the
// package promises: one source of truth, JSON-safe events, boundary parsing.

const minimalConfig = {
  seed: 1,
  experiment_id: 'x',
  population: [
    { id: 'c01', name: 'A', role: 'miner', driver: { kind: 'bot', strategy: 'random' } },
  ],
};

describe('world table', () => {
  it('matches the spec production table', () => {
    expect(ROLE_NAMES).toEqual([
      'miner',
      'logger',
      'smelter',
      'mill',
      'toolmaker',
      'furniture_maker',
    ]);
    expect(GOODS).toEqual(['ore', 'timber', 'ingot', 'plank', 'tool', 'furniture']);
    expect(FINAL_GOODS).toEqual(['tool', 'furniture']);
    expect(ROLES.furniture_maker).toEqual({
      verb: 'produce',
      inputs: { plank: 3, tool: 1 },
      output: 'furniture',
      capacity: 2,
      npc_market: true,
    });
    expect(producerOf('ingot')).toBe('smelter');
  });
});

describe('run config', () => {
  it('fills every economy default from the spec table', () => {
    const cfg = RunConfig.parse(minimalConfig);
    expect(cfg.economy.starting_cash).toBe(600);
    expect(cfg.economy.overdraft_limit).toBe(-200);
    expect(cfg.economy.license_reserve).toBe(750);
    expect(cfg.economy.end_inventory_fraction).toBe(0.5);
    expect(cfg.economy.reference_prices).toEqual({
      ore: 15,
      timber: 20,
      ingot: 55,
      plank: 45,
      tool: 160,
      furniture: 400,
    });
    expect(cfg.knobs.horizon).toEqual({ kind: 'random', min_turns: 30, hazard: 0.1 });
    expect(cfg.limits.round_tool_calls).toBe(8);
    expect(demandFor(cfg)).toEqual({ tool: { a: 240, b: 10 }, furniture: { a: 640, b: 30 } });
  });
  it('parses the checked-in baseline config', () => {
    const text = readFileSync(new URL('../../../configs/baseline.yaml', import.meta.url), 'utf8');
    const cfg = RunConfig.parse(parseYaml(text));
    expect(cfg.population).toHaveLength(12);
    expect(cfg.population.filter((p) => p.role === 'mill')).toHaveLength(2);
  });
  it('rejects duplicate company ids', () => {
    const dup = {
      ...minimalConfig,
      population: [minimalConfig.population[0], minimalConfig.population[0]],
    };
    expect(RunConfig.safeParse(dup).success).toBe(false);
  });
  it('rejects a demand profile that names no entry', () => {
    const bad = { ...minimalConfig, knobs: { demand_profile: 'scarcity' } };
    expect(RunConfig.safeParse(bad).success).toBe(false);
    const good = {
      ...bad,
      economy: {
        demand_profiles: { scarcity: { tool: { a: 120, b: 10 }, furniture: { a: 320, b: 30 } } },
      },
    };
    expect(demandFor(RunConfig.parse(good)).tool).toEqual({ a: 120, b: 10 });
  });
});

// A fixture per member. Record<...> over the derived type list means adding an action or event
// without a fixture is a compile error, which is the test that keeps taggedUnion's cast honest.
const actionFixtures: Record<ActionType, unknown> = {
  post_message: { type: 'post_message', text: 'hi' },
  send_dm: { type: 'send_dm', to: 'c02', text: 'hi' },
  propose_contract: {
    type: 'propose_contract',
    counterparty: 'c02',
    terms_text: '',
    obligations: [
      { kind: 'goods', by: 'proposer', good: 'ore', qty: 4, due_turn: 3 },
      { kind: 'cash', by: 'counterparty', amount: 60, due_turn: 3 },
    ],
  },
  accept_contract: { type: 'accept_contract', contract: 'k1' },
  reject_contract: { type: 'reject_contract', contract: 'k1' },
  withdraw_contract: { type: 'withdraw_contract', contract: 'k1' },
  deliver: { type: 'deliver', contract: 'k1', obligation: 0, qty: 2 },
  pay: { type: 'pay', contract: 'k1', obligation: 1, amount: 60 },
  transfer: { type: 'transfer', to: 'c02', what: { kind: 'cash', amount: 10 } },
  extract: { type: 'extract', from: { kind: 'grove', grove: 'g1' }, qty: 8 },
  produce: { type: 'produce', good: 'plank', qty: 4 },
  sell_npc: { type: 'sell_npc', good: 'tool', qty: 1 },
  scrap: { type: 'scrap', good: 'ore', qty: 1 },
  buy_license: { type: 'buy_license', role: 'mill' },
  bid_license: { type: 'bid_license', role: 'mill', amount: 800 },
  rebrand: { type: 'rebrand', name: 'Newco' },
};

describe('actions', () => {
  it.each(ACTION_TYPES)('%s parses its fixture and survives JSON', (type) => {
    const parsed = Action.parse(actionFixtures[type]);
    expect(Action.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
  it('rejects an unknown key', () => {
    expect(Action.safeParse({ type: 'scrap', good: 'ore', qty: 1, extra: 1 }).success).toBe(false);
  });
  it('rejects a produce order for a good nobody produces', () => {
    expect(Action.safeParse({ type: 'produce', good: 'ore', qty: 1 }).success).toBe(false);
  });
  it('parses one bad action without blocking the rest', () => {
    const results = parseActionBatch({
      actions: [actionFixtures.scrap, { type: 'scrap', good: 'gold', qty: 1 }, actionFixtures.pay],
    });
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    const bad = results[1];
    if (bad === undefined || bad.ok) throw new Error('expected a failure at index 1');
    expect(bad.error.code).toBe('INVALID_ACTION');
    expect(bad.error.reason).toContain('good');
  });
  it('turns a malformed body into one INVALID_ACTION result', () => {
    expect(parseActionBatch('nope')).toEqual([
      { ok: false, error: { code: 'INVALID_ACTION', reason: 'body must be { actions: [...] }' } },
    ]);
  });
});

const env = (type: EventType, payload: unknown, actor: string | null = null) => ({
  id: 'r1:1',
  run_id: 'r1',
  turn: 1,
  round: 1,
  seq: 1,
  actor,
  type,
  payload,
});
const terms = {
  proposer: 'c01',
  counterparty: 'c02',
  terms_text: 'ore for cash',
  obligations: [{ kind: 'goods', by: 'proposer', good: 'ore', qty: 4, due_turn: 3 }],
};

const eventFixtures: Record<EventType, unknown> = {
  run_started: env('run_started', { config: RunConfig.parse(minimalConfig) }),
  round_opened: env('round_opened', {}),
  round_resolved: env('round_resolved', {}),
  turn_closed: env('turn_closed', {}),
  run_paused: env('run_paused', { reason: 'rate_limit' }),
  run_resumed: env('run_resumed', {}),
  run_ended: env('run_ended', { reason: 'horizon_roll', scores: { c01: 1840 } }),
  action_submitted: env('action_submitted', { index: 0, action: actionFixtures.scrap }, 'c01'),
  action_rejected: env(
    'action_rejected',
    {
      index: 1,
      action: actionFixtures.pay,
      code: 'INSUFFICIENT_CASH',
      reason: 'cash is 10, owed 60',
    },
    'c01',
  ),
  contract_proposed: env('contract_proposed', { ...terms, contract: 'k1' }, 'c01'),
  contract_accepted: env('contract_accepted', { contract: 'k1' }, 'c02'),
  contract_rejected: env('contract_rejected', { contract: 'k1' }, 'c02'),
  contract_withdrawn: env('contract_withdrawn', { contract: 'k1' }, 'c01'),
  contract_expired: env('contract_expired', { contract: 'k1' }),
  escrow_deposited: env('escrow_deposited', { contract: 'k1', obligation: 0, units: 4 }, 'c01'),
  escrow_released: env('escrow_released', { contract: 'k1' }),
  escrow_refunded: env('escrow_refunded', { contract: 'k1', party: 'proposer' }),
  escrow_forfeited: env('escrow_forfeited', { contract: 'k1', party: 'counterparty' }),
  penalty_charged: env('penalty_charged', { contract: 'k1', party: 'counterparty', amount: 45 }),
  contract_completed: env('contract_completed', { contract: 'k1' }),
  contract_defaulted: env('contract_defaulted', {
    contract: 'k1',
    by: ['proposer'],
    unmet_value: 60,
  }),
  transfer_made: env('transfer_made', { to: 'c02', what: { kind: 'cash', amount: 25 } }, 'c01'),
  message_posted: env('message_posted', { text: 'selling ore' }, 'c01'),
  dm_sent: env('dm_sent', { to: 'c02', text: 'deal?' }, 'c01'),
  extraction_completed: env(
    'extraction_completed',
    { good: 'timber', qty: 6, from: { kind: 'grove', grove: 'g2' } },
    'c03',
  ),
  production_completed: env(
    'production_completed',
    { good: 'plank', qty: 4, consumed: { timber: 4 } },
    'c07',
  ),
  npc_market_cleared: env('npc_market_cleared', {
    good: 'tool',
    intercept: 240,
    qty: 3,
    price: 210,
    sales: { c09: 3 },
  }),
  scrap_sold: env('scrap_sold', { good: 'ore', qty: 2, proceeds: 9 }, 'c01'),
  upkeep_charged: env('upkeep_charged', { amount: 40 }, 'c01'),
  storage_charged: env('storage_charged', { units: 13, amount: 13 }, 'c07'),
  income_paid: env('income_paid', { amount: 20 }, 'c07'),
  grove_regrew: env('grove_regrew', { grove: 'g1', stock: 22 }),
  shock_applied: env('shock_applied', {
    shock: { kind: 'demand_slump', good: 'furniture' },
    until_turn: 4,
  }),
  company_bankrupt: env(
    'company_bankrupt',
    { cash: -230, contracts_defaulted: ['k1'], inventory_scrapped: { ore: 3 } },
    'c01',
  ),
  license_bought: env('license_bought', { role: 'smelter', price: 1500 }, 'c01'),
  license_auctioned: env('license_auctioned', {
    role: 'mill',
    result: { kind: 'sold', winner: 'c08', bid: 800 },
  }),
  company_rebranded: env(
    'company_rebranded',
    { old_name: 'Deepcut', new_name: 'Newco', fee: 300 },
    'c02',
  ),
  agent_trace_recorded: env('agent_trace_recorded', { trace_id: 't1' }, 'c01'),
  agent_replaced_by_bot: env(
    'agent_replaced_by_bot',
    { strategy: 'honest_trader', reason: 'session failed 3 times' },
    'c01',
  ),
  bug_report_filed: env('bug_report_filed', { text: 'deliver rejected my own contract' }, 'c01'),
};

describe('events', () => {
  it.each(EVENT_TYPES)('%s parses its fixture and survives JSON', (type) => {
    const parsed = Event.parse(eventFixtures[type]);
    expect(Event.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
  it('narrows the payload by type', () => {
    const e = Event.parse(eventFixtures.contract_defaulted);
    if (e.type !== 'contract_defaulted') throw new Error('wrong type');
    expect(e.payload.by).toEqual(['proposer']);
  });
});
