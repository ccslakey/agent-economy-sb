import { describe, expect, it } from 'vitest';
import { latestClean, provenanceDifferences } from './benchmark.ts';

describe('latest clean run', () => {
  const run = (id: string, seed: number, created_at: string, bot_handoffs = 0) => ({
    id,
    experiment: 'exp',
    variant: 'llm-miner',
    seed,
    created_at,
    bot_handoffs,
  });

  it('drops a run a bot had to finish and keeps the latest of the rest for each seed', () => {
    const first = run('r1', 104, '2026-11-04T01:00:00Z');
    const replay = run('r2', 104, '2026-11-04T03:00:00Z');
    const handed = run('r3', 104, '2026-11-04T05:00:00Z', 2);
    const other = run('r4', 105, '2026-11-04T01:00:00Z');
    const { kept, dropped } = latestClean([first, replay, handed, other]);
    expect(kept).toEqual([replay, other]);
    expect(dropped).toEqual([
      { run: handed, reason: '2 bot handoffs' },
      { run: first, reason: 'superseded by r2, played later' },
    ]);
  });

  it('keeps every run when each game was played once', () => {
    const runs = [run('r1', 104, '2026-11-04T01:00:00Z'), run('r2', 105, '2026-11-04T01:00:00Z')];
    expect(latestClean(runs)).toEqual({ kept: runs, dropped: [] });
  });
});

describe('provenance differences', () => {
  const recorded = {
    source_revision: 'abc',
    cli_version: '2.1.0',
    prompt_variant: 'neutral',
    prompt_sha256: 'p'.repeat(64),
    docs_sha256: 'd'.repeat(64),
    recorded_at: '2026-11-04T00:00:00.000Z',
    resolved_models: { sonnet: ['claude-sonnet-5-5'] },
  };

  it('is empty when every run was played by the same software, prompt, docs, and model ids', () => {
    expect(
      provenanceDifferences([
        { experiment: 'a', provenance: recorded },
        { experiment: 'a', provenance: { ...recorded, recorded_at: '2026-11-05T00:00:00.000Z' } },
      ]),
    ).toEqual([]);
  });

  it('still names a field that no run recorded or knows, so old runs never read as a verified match', () => {
    const backfilled = { ...recorded, source_revision: 'abc-inferred', cli_version: 'unknown' };
    expect(
      provenanceDifferences([
        { experiment: 'old', provenance: backfilled },
        { experiment: 'old', provenance: backfilled },
      ]),
    ).toEqual(['cli_version unknown (old ×2)']);
    expect(
      provenanceDifferences([
        { experiment: 'old', provenance: { resolved_models: { sonnet: ['claude-sonnet-4-5'] } } },
        { experiment: 'old', provenance: { resolved_models: { sonnet: ['claude-sonnet-4-5'] } } },
      ]),
    ).toEqual([
      'source_revision unrecorded (old ×2)',
      'cli_version unrecorded (old ×2)',
      'prompt_variant unrecorded (old ×2)',
      'prompt_sha256 unrecorded (old ×2)',
      'docs_sha256 unrecorded (old ×2)',
    ]);
  });

  it('names each field that differs, the runs on each side, and any dirty tree', () => {
    const lines = provenanceDifferences([
      { experiment: 'sonnet', provenance: recorded },
      { experiment: 'sonnet', provenance: recorded },
      {
        experiment: 'opus',
        provenance: {
          ...recorded,
          source_revision: 'def-dirty',
          resolved_models: { opus: ['claude-opus-5-5'] },
        },
      },
      // A run from before provenance existed: the route serves only its resolved models.
      { experiment: 'old', provenance: { resolved_models: { sonnet: ['claude-sonnet-4-5'] } } },
    ]);
    expect(lines).toEqual([
      'source_revision differs: abc (sonnet ×2) | def-dirty (opus ×1) | unrecorded (old ×1)',
      'cli_version differs: 2.1.0 (sonnet ×2, opus ×1) | unrecorded (old ×1)',
      'prompt_variant differs: neutral (sonnet ×2, opus ×1) | unrecorded (old ×1)',
      `prompt_sha256 differs: ${'p'.repeat(64)} (sonnet ×2, opus ×1) | unrecorded (old ×1)`,
      `docs_sha256 differs: ${'d'.repeat(64)} (sonnet ×2, opus ×1) | unrecorded (old ×1)`,
      'resolved_models differs: sonnet=claude-sonnet-5-5 (sonnet ×2) | opus=claude-opus-5-5 (opus ×1) | sonnet=claude-sonnet-4-5 (old ×1)',
      'dirty source tree: opus ×1',
    ]);
  });
});
