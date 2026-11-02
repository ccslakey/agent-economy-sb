import {
  Action,
  CompanyId,
  type Event,
  RunConfig,
  type RunConfigInput,
  RunId,
} from '@agent-economy/schema';
import { describe, expect, it } from 'vitest';
import { capitalRows, defaultCases, proposalCases, summarize } from './analysis.ts';
import { apply, initialState } from './fold.ts';
import { rngFor } from './rng.ts';
import { type StepInput, start, step } from './step.ts';

// Scripted games whose defaults and proposals have known mechanisms, so each label is checked
// against a case built to earn it and against one built not to.

const bot = { kind: 'bot', strategy: 'honest_trader' } as const;
const population: RunConfigInput['population'] = [
  { id: 'c01', name: 'Ironreach', role: 'miner', driver: bot },
  { id: 'c03', name: 'Fellwood', role: 'logger', driver: bot },
  { id: 'c04', name: 'Saltpine', role: 'logger', driver: bot },
  { id: 'c05', name: 'Emberworks', role: 'smelter', driver: bot },
];

function game() {
  const config = RunConfig.parse({
    seed: 11,
    experiment_id: 'analysis-test',
    population,
    economy: {
      demand_noise: 0,
      starting_inventory: {
        miner: { ore: 12 },
        logger: {},
        smelter: {},
        mill: {},
        toolmaker: {},
        furniture_maker: {},
      },
    },
    knobs: { horizon: { kind: 'fixed', last_turn: 4 }, shocks: 'off' },
  });
  const started = start(config, RunId.parse('r1'));
  const log: Event[] = [];
  let state = initialState(started);
  const run = (input: StepInput) => {
    const events = step(state, input, rngFor(config.seed, state.turn));
    log.push(...events);
    state = events.reduce(apply, state);
    return events;
  };
  const submit = (company: string, actions: unknown[]) =>
    run({
      kind: 'submit',
      company: CompanyId.parse(company),
      actions: actions.map((a) => Action.parse(a)),
    });
  const resolve = () => run({ kind: 'resolve_round' });
  const closeTurn = () => {
    while (state.phase.kind === 'round') resolve();
    run({ kind: 'operations' });
  };
  const sale = (counterparty: string, good: string, qty: number, cash: number, due: number) => ({
    type: 'propose_contract',
    counterparty,
    terms_text: '',
    obligations: [
      { kind: 'goods', by: 'proposer', good, qty, due_turn: due },
      { kind: 'cash', by: 'counterparty', amount: cash, due_turn: due },
    ],
  });
  const purchase = (
    counterparty: string,
    good: string,
    qty: number,
    cash: number,
    due: number,
  ) => ({
    type: 'propose_contract',
    counterparty,
    terms_text: '',
    obligations: [
      { kind: 'goods', by: 'counterparty', good, qty, due_turn: due },
      { kind: 'cash', by: 'proposer', amount: cash, due_turn: due },
    ],
  });
  return { started, log, submit, resolve, closeTurn, sale, purchase, state: () => state };
}

describe('default cases', () => {
  it('labels a default the party could have met but never attempted, and a late acceptance', () => {
    const g = game();
    g.submit('c01', [g.sale('c05', 'ore', 4, 60, 1)]);
    g.resolve();
    g.submit('c05', [{ type: 'accept_contract', contract: 'k1' }]);
    g.resolve();
    g.closeTurn();
    const cases = defaultCases(g.started, g.log);
    expect(cases.map((c) => c.party)).toEqual(['c01', 'c05']);
    const miner = cases[0];
    expect(miner).toMatchObject({ contract: 'k1', counterparty: 'c05', turn: 1, accepted_turn: 1 });
    expect(miner?.labels).toEqual(['no_attempt', 'had_means', 'late_acceptance']);
    expect(miner?.obligations).toEqual([
      {
        index: 0,
        kind: 'goods',
        good: 'ore',
        remaining: 4,
        deposited: 0,
        attempts: 0,
        rejections: [],
        held_at_last_round: 12,
      },
    ]);
    expect(cases[1]?.obligations[0]).toMatchObject({
      kind: 'cash',
      remaining: 60,
      held_at_last_round: 600,
    });
  });

  it('labels a rejected short delivery and a partial deposit', () => {
    const g = game();
    g.submit('c03', [g.sale('c05', 'timber', 5, 100, 2)]);
    g.submit('c01', [g.sale('c05', 'ore', 6, 90, 2)]);
    g.resolve();
    const idOf = (proposer: string) =>
      Object.values(g.state().contracts).find((k) => k.proposer === proposer)?.id ?? 'none';
    const timber = idOf('c03');
    const ore = idOf('c01');
    g.submit('c05', [
      { type: 'accept_contract', contract: timber },
      { type: 'accept_contract', contract: ore },
    ]);
    g.resolve();
    g.closeTurn();
    g.submit('c03', [{ type: 'deliver', contract: timber, obligation: 0, qty: 5 }]);
    g.submit('c01', [{ type: 'deliver', contract: ore, obligation: 0, qty: 2 }]);
    g.submit('c05', [
      { type: 'pay', contract: timber, obligation: 1, amount: 100 },
      { type: 'pay', contract: ore, obligation: 1, amount: 90 },
    ]);
    g.closeTurn();
    const cases = defaultCases(g.started, g.log);
    const logger = cases.find((c) => c.party === 'c03');
    expect(logger?.labels).toEqual(['rejected_short']);
    expect(logger?.obligations[0]?.rejections).toEqual(['INSUFFICIENT_INVENTORY']);
    expect(logger?.obligations[0]?.held_at_last_round).toBe(0);
    const miner = cases.find((c) => c.party === 'c01');
    expect(miner?.labels).toEqual(['partial', 'had_means']);
    expect(miner?.obligations[0]).toMatchObject({ remaining: 4, deposited: 2, attempts: 1 });
    expect(cases.some((c) => c.party === 'c05')).toBe(false);
  });
});

describe('proposal cases and capital rows', () => {
  it('sees a counterparty default, a clean alternative, a broadcast, and a switch', () => {
    const g = game();
    g.submit('c05', [g.purchase('c03', 'timber', 5, 100, 1)]);
    g.resolve();
    g.submit('c03', [{ type: 'accept_contract', contract: 'k1' }]);
    g.resolve();
    g.submit('c05', [{ type: 'pay', contract: 'k1', obligation: 1, amount: 100 }]);
    g.closeTurn();
    g.submit('c05', [
      g.purchase('c03', 'timber', 5, 100, 3),
      g.purchase('c04', 'timber', 5, 110, 3),
    ]);
    g.closeTurn();
    const cases = proposalCases(g.started, g.log);
    expect(cases).toHaveLength(3);
    expect(cases[0]).toMatchObject({
      counterparty: 'c03',
      good: 'timber',
      direction: 'buy',
      unit_price_ratio: 1,
      counterparty_defaults: 0,
      burned_you: 0,
      clean_alternative: true,
      broadcast: false,
      switched_after_burn: false,
      outcome: 'accepted',
    });
    expect(cases[1]).toMatchObject({
      counterparty: 'c03',
      counterparty_defaults: 1,
      burned_you: 1,
      clean_alternative: true,
      broadcast: true,
      switched_after_burn: false,
      outcome: 'open',
    });
    expect(cases[2]).toMatchObject({
      counterparty: 'c04',
      counterparty_defaults: 0,
      unit_price_ratio: 1.1,
      broadcast: true,
      switched_after_burn: true,
    });
    const rows = capitalRows(g.started, g.log);
    const smelterTurn1 = rows.find((r) => r.turn === 1 && r.company === 'c05');
    expect(smelterTurn1).toMatchObject({ escrow: 0, promised: 0 });
    expect(smelterTurn1?.cash).toBe(600 - 40);
    const summary = summarize(defaultCases(g.started, g.log), cases, rows);
    expect(summary.proposals).toMatchObject({
      total: 3,
      accepted: 1,
      to_defaulter: 1,
      to_defaulter_with_clean_alternative: 1,
      to_one_that_burned_you: 1,
      broadcast: 2,
      switched_after_burn: 1,
      mean_price_ratio_defaulter: 1,
    });
    expect(summary.defaults.by_label).toMatchObject({ no_attempt: 1 });
  });

  it('shows escrow locked across a turn boundary', () => {
    const g = game();
    g.submit('c01', [g.sale('c05', 'ore', 4, 60, 3)]);
    g.resolve();
    g.submit('c05', [{ type: 'accept_contract', contract: 'k1' }]);
    g.resolve();
    g.submit('c01', [{ type: 'deliver', contract: 'k1', obligation: 0, qty: 3 }]);
    g.closeTurn();
    const row = capitalRows(g.started, g.log).find((r) => r.turn === 1 && r.company === 'c01');
    expect(row).toMatchObject({ escrow: 45, promised: 15, squeezed: false });
    expect(row?.inventory_value).toBe(9 * 15);
  });
});
