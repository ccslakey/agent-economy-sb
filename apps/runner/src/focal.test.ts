import { reputationOf, scoreOf } from '@agent-economy/engine';
import { CompanyId, RunConfig, type RunState } from '@agent-economy/schema';
import { describe, expect, it } from 'vitest';
import { focalSeat, focalTable, seatOutcome } from './focal.ts';
import { playBots } from './play.ts';

// The focal table over bot-played games: the all-bot run is real, and the "LLM" run is the same
// game with one seat's driver relabeled and its cash moved, so every paired difference is known.

const bot = { kind: 'bot', strategy: 'honest_trader' } as const;
const llm = {
  kind: 'llm',
  model: 'sonnet',
  effort: 'medium',
  harness_version: 1,
  prompt_variant: 'neutral',
} as const;
const roster = [
  { id: 'c01', name: 'Ironreach', role: 'miner' },
  { id: 'c03', name: 'Fellwood', role: 'logger' },
  { id: 'c05', name: 'Emberworks', role: 'smelter' },
  { id: 'c07', name: 'Birchline Mills', role: 'mill' },
  { id: 'c09', name: 'Anvilgate', role: 'toolmaker' },
  { id: 'c11', name: 'Hearthstead', role: 'furniture_maker' },
];
const botsConfig = (seed: number) =>
  RunConfig.parse({
    seed,
    experiment_id: 'focal-test/bots',
    population: roster.map((r) => ({ ...r, driver: bot })),
    knobs: { horizon: { kind: 'fixed', last_turn: 6 }, shocks: 'off' },
  });
const focalConfig = (seed: number, seat: string) =>
  RunConfig.parse({
    ...botsConfig(seed),
    experiment_id: `focal-test/llm-${seat}`,
    population: roster.map((r) => ({ ...r, driver: r.id === seat ? llm : bot })),
  });
/** The bot game relabeled as a focal run, with the seat's cash moved by `delta`. */
const relabel = (state: RunState, seat: string, delta: number): RunState => {
  const id = CompanyId.parse(seat);
  const company = state.companies[id];
  if (company === undefined) throw new Error(`no ${seat}`);
  return {
    ...state,
    config: focalConfig(state.config.seed, seat),
    companies: { ...state.companies, [id]: { ...company, cash: company.cash + delta } },
  };
};

describe('focal company', () => {
  it('names the one LLM seat of a config and none for an all-bot roster', () => {
    expect(focalSeat(botsConfig(1))).toBeNull();
    expect(focalSeat(focalConfig(1, 'c05'))?.id).toBe('c05');
    const two = RunConfig.parse({
      ...botsConfig(1),
      population: roster.map((r) => ({
        ...r,
        driver: r.id === 'c01' || r.id === 'c03' ? llm : bot,
      })),
    });
    expect(() => focalSeat(two)).toThrow(/2 LLM companies/);
  });

  it('reads a seat off the folded state the way the engine scores it', () => {
    const { state } = playBots(botsConfig(7));
    const seat = CompanyId.parse('c09');
    const outcome = seatOutcome(state, seat);
    const company = state.companies[seat];
    if (company === undefined) throw new Error('no toolmaker');
    expect(outcome.score).toBe(scoreOf(state, company));
    expect(outcome.completed).toBe(reputationOf(state, company).completed);
    expect(outcome.defaulted).toBe(reputationOf(state, company).defaulted);
    expect(outcome.completed).toBeGreaterThan(0);
    expect(outcome.trade_value).toBeGreaterThan(0);
    expect(outcome.bankrupt).toBe(0);
    expect(outcome.others_score).toBe(
      Object.values(state.companies)
        .filter((c) => c.id !== seat)
        .reduce((sum, c) => sum + scoreOf(state, c), 0),
    );
  });

  it('pairs each LLM seat with the bot in the same seat by seed and prints the differences', () => {
    const bots = [7, 8].map((seed) => ({
      variant: 'bots',
      seed,
      state: playBots(botsConfig(seed)).state,
    }));
    const runs = [
      ...bots,
      { variant: 'llm-toolmaker', seed: 7, state: relabel(bots[0]?.state as RunState, 'c09', 100) },
      { variant: 'llm-toolmaker', seed: 8, state: relabel(bots[1]?.state as RunState, 'c09', 300) },
      { variant: 'llm-miner', seed: 7, state: relabel(bots[0]?.state as RunState, 'c01', -50) },
    ];
    const table = focalTable(runs);
    const blocks = table.split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatch(/^miner c01 Ironreach\s+llm \(n=1\)\s+bot \(n=2\)\s+Δ \(n=1\)/);
    expect(blocks[1]).toMatch(/^toolmaker c09 Anvilgate\s+llm \(n=2\)\s+bot \(n=2\)\s+Δ \(n=2\)/);
    const row = (block: string, key: string) =>
      block
        .split('\n')
        .find((l) => l.startsWith(key))
        ?.slice(32)
        .trim()
        .split(/\s+/);
    expect(row(blocks[1] as string, 'score')?.[2]).toBe('200');
    expect(row(blocks[0] as string, 'score')?.[2]).toBe('-50');
    expect(row(blocks[1] as string, 'others_score')?.[2]).toBe('0');
    expect(row(blocks[1] as string, 'completed')?.[2]).toBe('0');
    expect(focalTable(bots)).toBe('no focal runs');
  });
});
