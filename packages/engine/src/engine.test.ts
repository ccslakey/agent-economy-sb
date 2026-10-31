import {
  Action,
  CompanyId,
  Event,
  type EventType,
  GroveId,
  RunConfig,
  type RunConfigInput,
  RunId,
  RunState,
} from '@agent-economy/schema';
import { describe, expect, it } from 'vitest';
import {
  apply,
  fold,
  initialState,
  proRata,
  rngFor,
  type StepInput,
  start,
  step,
} from './index.ts';

// Every expected value below is arithmetic over the spec's tables with demand noise off.

const bot = { kind: 'bot', strategy: 'honest_trader' } as const;
const population: RunConfigInput['population'] = [
  { id: 'c01', name: 'Ironreach', role: 'miner', driver: bot },
  { id: 'c03', name: 'Fellwood', role: 'logger', driver: bot },
  { id: 'c04', name: 'Saltpine', role: 'logger', driver: bot },
  { id: 'c05', name: 'Emberworks', role: 'smelter', driver: bot },
  { id: 'c09', name: 'Anvilgate', role: 'toolmaker', driver: bot },
];

function game(
  economy: Partial<RunConfigInput['economy']> = {},
  knobs: Partial<RunConfigInput['knobs']> = {},
) {
  const config = RunConfig.parse({
    seed: 7,
    experiment_id: 'test',
    population,
    economy: { demand_noise: 0, ...economy },
    knobs,
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
  const closeTurn = () => {
    run({ kind: 'resolve_round' });
    run({ kind: 'resolve_round' });
    run({ kind: 'resolve_round' });
    return run({ kind: 'operations' });
  };
  /** Append an event the engine did not produce, to set up a scenario. */
  const inject = (body: { type: EventType; payload: unknown; actor?: string | null }) => {
    const seq = state.seq + 1;
    const event = Event.parse({
      id: `r1:${seq}`,
      run_id: 'r1',
      turn: state.turn,
      round: null,
      seq,
      actor: body.actor ?? null,
      type: body.type,
      payload: body.payload,
    });
    log.push(event);
    state = apply(state, event);
  };
  return { started, log, submit, closeTurn, run, inject, state: () => state, config };
}

const types = (events: Event[]): EventType[] => events.map((e) => e.type);
const grove = (g: ReturnType<typeof game>, id: string) => {
  const grv = g.state().groves[GroveId.parse(id)];
  if (grv === undefined) throw new Error(`no grove ${id}`);
  return grv;
};
const company = (g: ReturnType<typeof game>, id: string) => {
  const c = g.state().companies[CompanyId.parse(id)];
  if (c === undefined) throw new Error(`no company ${id}`);
  return c;
};

describe('initial state', () => {
  it('builds companies, groves, and intercepts from the config', () => {
    const g = game();
    expect(company(g, 'c05')).toMatchObject({
      cash: 600,
      inventory: { ore: 12 },
      roles: ['smelter'],
    });
    expect(company(g, 'c01').inventory).toEqual({});
    expect(Object.keys(g.state().groves)).toEqual(['g1', 'g2', 'g3']);
    expect(grove(g, 'g1').stock).toBe(30);
    expect(g.state().market.intercept).toEqual({ tool: 240, furniture: 640 });
    expect(g.state()).toMatchObject({ turn: 1, phase: { kind: 'round', round: 1 }, seq: 0 });
  });
});

describe('submission', () => {
  it('records orders and rejects what the license or capacity forbids', () => {
    const g = game();
    expect(
      types(g.submit('c01', [{ type: 'extract', from: { kind: 'ore_pit' }, qty: 12 }])),
    ).toEqual(['action_submitted']);
    expect(company(g, 'c01').pending_orders.extract).toEqual({
      ore: { qty: 12, from: { kind: 'ore_pit' } },
    });
    const rejected = g.submit('c05', [
      { type: 'produce', good: 'ingot', qty: 7 },
      { type: 'extract', from: { kind: 'ore_pit' }, qty: 1 },
      { type: 'produce', good: 'ingot', qty: 6 },
    ]);
    expect(types(rejected)).toEqual(['action_rejected', 'action_rejected', 'action_submitted']);
    expect(rejected.map((e) => (e.type === 'action_rejected' ? e.payload.code : null))).toEqual([
      'CAPACITY_EXCEEDED',
      'NOT_LICENSED',
      null,
    ]);
  });
  it('allows one batch per round and lets the latest order win across rounds', () => {
    const g = game();
    g.submit('c01', [{ type: 'extract', from: { kind: 'ore_pit' }, qty: 12 }]);
    const again = g.submit('c01', [{ type: 'extract', from: { kind: 'ore_pit' }, qty: 1 }]);
    expect(again[0]?.type === 'action_rejected' && again[0].payload.code).toBe(
      'BATCH_ALREADY_SUBMITTED',
    );
    expect(types(g.run({ kind: 'resolve_round' }))).toEqual(['round_resolved', 'round_opened']);
    expect(g.state().phase).toEqual({ kind: 'round', round: 2 });
    g.submit('c01', [{ type: 'extract', from: { kind: 'ore_pit' }, qty: 5 }]);
    expect(company(g, 'c01').pending_orders.extract.ore?.qty).toBe(5);
  });
  it('rejects a batch when no round is open', () => {
    const g = game();
    for (let i = 0; i < 3; i++) g.run({ kind: 'resolve_round' });
    expect(g.state().phase).toEqual({ kind: 'operations' });
    const late = g.submit('c01', [{ type: 'scrap', good: 'ore', qty: 1 }]);
    expect(late[0]?.type === 'action_rejected' && late[0].payload.code).toBe('ROUND_CLOSED');
  });
});

describe('operations step', () => {
  it('runs one turn of the metal chain with literal outcomes', () => {
    const g = game();
    g.submit('c01', [{ type: 'extract', from: { kind: 'ore_pit' }, qty: 12 }]);
    g.submit('c05', [{ type: 'produce', good: 'ingot', qty: 6 }]);
    g.submit('c09', [
      { type: 'produce', good: 'tool', qty: 3 },
      { type: 'sell_npc', good: 'tool', qty: 2 },
    ]);
    const events = g.closeTurn();

    expect(company(g, 'c01')).toMatchObject({ inventory: { ore: 12 }, cash: 600 - 40 - 12 });
    expect(company(g, 'c05')).toMatchObject({ inventory: { ingot: 6 }, cash: 600 - 40 - 6 });
    expect(company(g, 'c09')).toMatchObject({
      inventory: { tool: 1 },
      cash: 600 + 2 * 220 - 40 - 1,
    });

    const tools = events.find((e) => e.type === 'npc_market_cleared' && e.payload.good === 'tool');
    expect(tools?.type === 'npc_market_cleared' && tools.payload).toEqual({
      good: 'tool',
      intercept: 240,
      qty: 2,
      price: 220,
      sales: { c09: 2 },
    });
    const furniture = events.find(
      (e) => e.type === 'npc_market_cleared' && e.payload.good === 'furniture',
    );
    expect(furniture?.type === 'npc_market_cleared' && furniture.payload.price).toBe(640);
    expect(g.state().market.clears).toEqual([
      { turn: 1, good: 'tool', qty: 2, price: 220 },
      { turn: 1, good: 'furniture', qty: 0, price: 640 },
    ]);
    expect(g.state()).toMatchObject({ turn: 2, phase: { kind: 'round', round: 1 } });
    expect(company(g, 'c09').pending_orders.produce).toEqual({});
  });
  it('splits a short grove pro rata with the remainder in company id order', () => {
    const g = game({ groves: { count: 1, stock_cap: 9, regrowth: 4 } });
    g.submit('c03', [{ type: 'extract', from: { kind: 'grove', grove: 'g1' }, qty: 8 }]);
    g.submit('c04', [{ type: 'extract', from: { kind: 'grove', grove: 'g1' }, qty: 8 }]);
    g.closeTurn();
    expect(company(g, 'c03').inventory).toEqual({ timber: 5 });
    expect(company(g, 'c04').inventory).toEqual({ timber: 4 });
    expect(grove(g, 'g1').stock).toBe(4);
  });
  it('gives every logger its request when the grove holds enough', () => {
    const g = game();
    g.submit('c03', [{ type: 'extract', from: { kind: 'grove', grove: 'g2' }, qty: 8 }]);
    g.submit('c04', [{ type: 'extract', from: { kind: 'grove', grove: 'g2' }, qty: 8 }]);
    g.closeTurn();
    expect(company(g, 'c03').inventory).toEqual({ timber: 8 });
    expect(grove(g, 'g2').stock).toBe(18);
    expect(grove(g, 'g1').stock).toBe(30);
  });
  it('produces as much as inputs allow', () => {
    const g = game({
      starting_inventory: {
        miner: {},
        logger: {},
        smelter: { ore: 5 },
        mill: {},
        toolmaker: {},
        furniture_maker: {},
      },
    });
    g.submit('c05', [{ type: 'produce', good: 'ingot', qty: 6 }]);
    const events = g.closeTurn();
    const produced = events.find((e) => e.type === 'production_completed');
    expect(produced?.type === 'production_completed' && produced.payload).toEqual({
      good: 'ingot',
      qty: 2,
      consumed: { ore: 4 },
    });
    expect(company(g, 'c05').inventory).toEqual({ ore: 1, ingot: 2 });
  });
  it('scraps at 30% of reference and never more than held', () => {
    const g = game();
    g.submit('c05', [{ type: 'scrap', good: 'ore', qty: 20 }]);
    const events = g.closeTurn();
    const sold = events.find((e) => e.type === 'scrap_sold');
    expect(sold?.type === 'scrap_sold' && sold.payload).toEqual({
      good: 'ore',
      qty: 12,
      proceeds: 54,
    });
    expect(company(g, 'c05')).toMatchObject({ inventory: {}, cash: 600 + 54 - 40 });
  });
  it('prices at the scrap floor when the market is flooded', () => {
    const g = game({
      starting_inventory: {
        miner: {},
        logger: {},
        smelter: {},
        mill: {},
        toolmaker: { tool: 30 },
        furniture_maker: {},
      },
    });
    g.submit('c09', [{ type: 'sell_npc', good: 'tool', qty: 30 }]);
    const events = g.closeTurn();
    const tools = events.find((e) => e.type === 'npc_market_cleared' && e.payload.good === 'tool');
    expect(tools?.type === 'npc_market_cleared' && tools.payload.price).toBe(42);
  });
  it('moves the intercept by at most the configured noise', () => {
    const g = game({ demand_noise: 0.05 });
    const events = g.closeTurn();
    const tools = events.find((e) => e.type === 'npc_market_cleared' && e.payload.good === 'tool');
    const intercept = tools?.type === 'npc_market_cleared' ? tools.payload.intercept : Number.NaN;
    expect(intercept).toBeGreaterThanOrEqual(228);
    expect(intercept).toBeLessThanOrEqual(252);
    expect(intercept).not.toBe(240);
  });
});

describe('pro rata', () => {
  it('floors shares and hands leftovers out in id order', () => {
    const a = CompanyId.parse('c03');
    const b = CompanyId.parse('c04');
    expect(
      proRata(9, [
        { company: b, qty: 8 },
        { company: a, qty: 8 },
      ]),
    ).toEqual([
      { company: a, qty: 5 },
      { company: b, qty: 4 },
    ]);
    expect(
      proRata(10, [
        { company: a, qty: 2 },
        { company: b, qty: 6 },
      ]),
    ).toEqual([
      { company: a, qty: 2 },
      { company: b, qty: 6 },
    ]);
  });
});

describe('rng', () => {
  it('is a pure function of seed, turn, and purpose', () => {
    expect(rngFor(1, 1)('demand_noise:tool')).toBe(rngFor(1, 1)('demand_noise:tool'));
    expect(rngFor(1, 1)('demand_noise:tool')).not.toBe(rngFor(1, 2)('demand_noise:tool'));
    expect(rngFor(1, 1)('demand_noise:tool')).not.toBe(rngFor(2, 1)('demand_noise:tool'));
    expect(rngFor(1, 1)('a')).not.toBe(rngFor(1, 1)('b'));
    for (const p of ['a', 'b', 'c', 'demand_noise:furniture']) {
      const x = rngFor(3, 5)(p);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('replay', () => {
  it('rebuilds the same state from the log and survives JSON', () => {
    const g = game();
    g.submit('c01', [{ type: 'extract', from: { kind: 'ore_pit' }, qty: 12 }]);
    g.submit('c05', [{ type: 'produce', good: 'ingot', qty: 6 }]);
    g.closeTurn();
    g.submit('c05', [{ type: 'scrap', good: 'ingot', qty: 1 }]);
    g.closeTurn();
    const replayed = fold(g.started, g.log);
    expect(replayed).toEqual(g.state());
    expect(RunState.parse(JSON.parse(JSON.stringify(replayed)))).toEqual(replayed);
    expect(g.log.map((e) => e.seq)).toEqual(g.log.map((_, i) => i + 1));
  });
});

describe('world', () => {
  it('regrows groves toward the cap and leaves full ones alone', () => {
    const g = game();
    g.submit('c03', [{ type: 'extract', from: { kind: 'grove', grove: 'g2' }, qty: 8 }]);
    g.submit('c04', [{ type: 'extract', from: { kind: 'grove', grove: 'g2' }, qty: 8 }]);
    const regrew = g.closeTurn().filter((e) => e.type === 'grove_regrew');
    expect(regrew.map((e) => (e.type === 'grove_regrew' ? e.payload : null))).toEqual([
      { grove: 'g2', stock: 18 },
    ]);
    g.closeTurn();
    g.closeTurn();
    g.closeTurn();
    expect(grove(g, 'g2').stock).toBe(30);
  });
  it('folds a grove fire and a demand slump into stock and prices', () => {
    const g = game();
    g.inject({
      type: 'shock_applied',
      payload: { shock: { kind: 'grove_fire', grove: 'g1' }, until_turn: 1 },
    });
    expect(grove(g, 'g1').stock).toBe(0);
    g.inject({
      type: 'shock_applied',
      payload: { shock: { kind: 'demand_slump', good: 'furniture' }, until_turn: 4 },
    });
    const cleared = g
      .closeTurn()
      .find((e) => e.type === 'npc_market_cleared' && e.payload.good === 'furniture');
    expect(cleared?.type === 'npc_market_cleared' && cleared.payload.intercept).toBe(480);
    expect(grove(g, 'g1').stock).toBe(4);
    expect(g.state().shocks).toEqual([
      { shock: { kind: 'demand_slump', good: 'furniture' }, until_turn: 4 },
    ]);
  });
  it('halves miner capacity during a strike and lifts it when the strike ends', () => {
    const g = game();
    g.inject({
      type: 'shock_applied',
      payload: { shock: { kind: 'miners_strike' }, until_turn: 2 },
    });
    const rejected = g.submit('c01', [{ type: 'extract', from: { kind: 'ore_pit' }, qty: 12 }]);
    expect(rejected[0]?.type === 'action_rejected' && rejected[0].payload).toMatchObject({
      code: 'CAPACITY_EXCEEDED',
      reason: 'ore capacity is 6 per turn',
    });
    g.closeTurn();
    g.closeTurn();
    expect(g.state().turn).toBe(3);
    expect(g.state().shocks).toEqual([]);
    expect(
      types(g.submit('c01', [{ type: 'extract', from: { kind: 'ore_pit' }, qty: 12 }])),
    ).toEqual(['action_submitted']);
  });
  it('draws at most one shock per turn, and none when shocks are off', () => {
    const on = game({ shock_chance: 1 });
    expect(types(on.closeTurn()).filter((t) => t === 'shock_applied')).toHaveLength(1);
    const off = game({ shock_chance: 1 }, { shocks: 'off' });
    expect(types(off.closeTurn())).not.toContain('shock_applied');
  });
  it('removes a company that falls below the overdraft limit', () => {
    const g = game({ starting_cash: 0, overdraft_limit: -30 });
    const events = g.closeTurn();
    const gone = events.find((e) => e.type === 'company_bankrupt' && e.actor === 'c05');
    expect(gone?.type === 'company_bankrupt' && gone.payload).toEqual({
      cash: -52,
      contracts_defaulted: [],
      inventory_scrapped: { ore: 12 },
    });
    expect(company(g, 'c05')).toMatchObject({
      standing: { kind: 'bankrupt', turn: 1 },
      inventory: {},
    });
    const late = g.submit('c05', [{ type: 'scrap', good: 'ore', qty: 1 }]);
    expect(late[0]?.type === 'action_rejected' && late[0].payload.reason).toBe(
      'company is bankrupt',
    );
    expect(types(g.closeTurn())).not.toContain('upkeep_charged');
  });
  it('ends a fixed game on its last turn with scores and opens no new turn', () => {
    const g = game({}, { horizon: { kind: 'fixed', last_turn: 2 } });
    expect(types(g.closeTurn())).not.toContain('run_ended');
    const events = g.closeTurn();
    expect(types(events).slice(-1)).toEqual(['run_ended']);
    const ended = events.at(-1);
    expect(ended?.type === 'run_ended' && ended.payload.reason).toBe('fixed_last_turn');
    expect(ended?.type === 'run_ended' && ended.payload.scores[CompanyId.parse('c05')]).toBe(
      600 - 52 - 52 + 90,
    );
    expect(g.state()).toMatchObject({ turn: 2, phase: { kind: 'ended' } });
    expect(() => g.run({ kind: 'resolve_round' })).toThrow();
  });
  it('rolls the random horizon only after the minimum turns', () => {
    const certain = game({}, { horizon: { kind: 'random', min_turns: 2, hazard: 1 } });
    expect(types(certain.closeTurn())).not.toContain('run_ended');
    expect(types(certain.closeTurn())).toContain('run_ended');
    const never = game({}, { horizon: { kind: 'random', min_turns: 1, hazard: 0 } });
    for (let i = 0; i < 3; i++) expect(types(never.closeTurn())).not.toContain('run_ended');
  });
});

describe('determinism', () => {
  const play = () => {
    const g = game(
      { demand_noise: 0.05, shock_chance: 0.5 },
      { horizon: { kind: 'fixed', last_turn: 40 } },
    );
    while (g.state().phase.kind !== 'ended') {
      g.submit('c01', [{ type: 'extract', from: { kind: 'ore_pit' }, qty: 6 }]);
      g.submit('c03', [{ type: 'extract', from: { kind: 'grove', grove: 'g1' }, qty: 8 }]);
      g.submit('c04', [{ type: 'extract', from: { kind: 'grove', grove: 'g1' }, qty: 8 }]);
      g.submit('c05', [{ type: 'produce', good: 'ingot', qty: 6 }]);
      g.submit('c09', [
        { type: 'produce', good: 'tool', qty: 3 },
        { type: 'sell_npc', good: 'tool', qty: 3 },
      ]);
      g.closeTurn();
    }
    return g;
  };
  it('produces a byte-identical log twice and replays to the same state', () => {
    const a = play();
    const b = play();
    expect(JSON.stringify(a.log)).toBe(JSON.stringify(b.log));
    expect(a.state().turn).toBe(40);
    expect(types(a.log).filter((t) => t === 'shock_applied').length).toBeGreaterThan(5);
    const replayed = fold(a.started, a.log);
    expect(replayed).toEqual(a.state());
    expect(RunState.parse(JSON.parse(JSON.stringify(replayed)))).toEqual(replayed);
  });
});
