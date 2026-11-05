import type { SeatOutcome } from '@agent-economy/engine';
import { describe, expect, it } from 'vitest';
import type { BenchmarkRun } from './api.ts';
import { benchmark, cell, meanDelta } from './benchmarks.ts';

const outcome = (score: number): SeatOutcome => ({
  score,
  completed: 1,
  defaulted: 0,
  trade_value: 10,
  bankrupt: 0,
  others_score: 1000 - score,
});
const recorded = {
  source_revision: 'abc',
  cli_version: '2.1.0',
  prompt_variant: 'neutral',
  prompt_sha256: 'p'.repeat(64),
  docs_sha256: 'd'.repeat(64),
  recorded_at: '2026-11-04T00:00:00.000Z',
  resolved_models: { sonnet: ['claude-sonnet-5-5'] },
};
const seat = (id: string, role: string, model = 'sonnet', harness = 2) => ({
  id,
  role,
  name: id,
  model,
  effort: 'medium',
  harness_version: harness,
});
const run = (
  experiment: string,
  variant: string,
  seed: number,
  scores: Record<string, number>,
  llm_seats: BenchmarkRun['llm_seats'] = [],
  extra: Partial<BenchmarkRun> = {},
): BenchmarkRun => ({
  id: `${experiment}/${variant}:${seed}`,
  experiment,
  variant,
  seed,
  created_at: '2026-11-04T00:00:00Z',
  llm_seats,
  seats: Object.fromEntries(Object.entries(scores).map(([id, s]) => [id, outcome(s)])),
  bot_handoffs: 0,
  cost: { sessions: 1, tokens_in: 0, tokens_out: 0, cost_usd: 0, duration_ms: 0 },
  provenance: recorded,
  ...extra,
});

describe('benchmark', () => {
  const bots = (experiment: string, seed: number) =>
    run(experiment, 'bots', seed, { c01: 100, c05: 200 });
  const llm = (experiment: string, seed: number, score: number, model = 'sonnet') =>
    run(experiment, 'llm-miner', seed, { c01: score, c05: 200 }, [seat('c01', 'miner', model)]);

  it('pairs each LLM run with the all-bot run of its seed in the same experiment', () => {
    const b = benchmark([bots('a', 1), bots('a', 2), llm('a', 1, 130), llm('a', 2, 90)]);
    expect(b.conditions).toEqual([
      { experiment: 'a', model: 'sonnet', harness: 2, label: 'sonnet · harness 2' },
    ]);
    expect(b.seats).toEqual([{ id: 'c01', role: 'miner', name: 'c01' }]);
    const c = cell(b, 'a', 'c01');
    expect(c?.pairs.map((p) => [p.seed, p.llm.score, p.bot.score])).toEqual([
      [1, 130, 100],
      [2, 90, 100],
    ]);
    expect(meanDelta(c?.pairs ?? [], 'score')).toBe(10);
    expect(meanDelta(c?.pairs ?? [], 'others_score')).toBe(-10);
    expect(b.provenance).toEqual([]);
  });

  it('counts an LLM run with no bot run of its seed as unpaired, and keeps conditions apart', () => {
    const b = benchmark([
      bots('a', 1),
      llm('a', 1, 130),
      llm('a', 3, 50),
      llm('b', 1, 70, 'ollama/gemma4'),
    ]);
    expect(b.conditions.map((c) => c.label)).toEqual([
      'sonnet · harness 2',
      'ollama/gemma4 · harness 2',
    ]);
    expect(cell(b, 'a', 'c01')).toMatchObject({ unpaired: 1 });
    expect(cell(b, 'a', 'c01')?.pairs).toHaveLength(1);
    // Experiment b has no all-bot run, so its one LLM run pairs with nothing.
    expect(cell(b, 'b', 'c01')).toMatchObject({ unpaired: 1, pairs: [] });
  });

  it('leaves out handed-off, superseded, and multi-LLM runs, and names why', () => {
    const handed = { ...llm('a', 1, 0), id: 'handed', bot_handoffs: 1 };
    const early = { ...llm('a', 2, 10), id: 'early', created_at: '2026-11-03T00:00:00Z' };
    const late = { ...llm('a', 2, 20), id: 'late' };
    const crowd = run('a', 'all-llm', 1, { c01: 1, c05: 2 }, [
      seat('c01', 'miner'),
      seat('c05', 'smelter'),
    ]);
    const b = benchmark([bots('a', 1), bots('a', 2), handed, early, late, crowd]);
    expect(b.dropped.map((d) => [d.run.id, d.reason])).toEqual([
      ['handed', '1 bot handoffs'],
      ['early', 'superseded by late, played later'],
      ['a/all-llm:1', '2 LLM seats, not a focal run'],
    ]);
    expect(cell(b, 'a', 'c01')?.pairs.map((p) => p.seed)).toEqual([2]);
  });

  it('reports the provenance that differs among the runs counted', () => {
    const b = benchmark([
      bots('a', 1),
      llm('a', 1, 130),
      {
        ...llm('b', 1, 70, 'ollama/gemma4'),
        provenance: { ...recorded, source_revision: 'def', resolved_models: {} },
      },
    ]);
    expect(b.provenance).toEqual([
      'source_revision differs: abc (a ×2) | def (b ×1)',
      'resolved_models differs: sonnet=claude-sonnet-5-5 (a ×2) | unrecorded (b ×1)',
    ]);
  });
});
