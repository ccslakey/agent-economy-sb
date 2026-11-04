import { describe, expect, it } from 'vitest';
import { acrossTable } from './across.ts';

// The across-experiment table on hand-made values, so every mean and paired difference is known.

const row = (table: string, key: string) =>
  table
    .split('\n')
    .find((l) => l.startsWith(key))
    ?.slice(32)
    .trim()
    .split(/\s{2,}/);

describe('across-experiment table', () => {
  it('pairs each later experiment with the first by seed within a group', () => {
    const table = acrossTable(
      ['sonnet', 'opus'],
      [
        { experiment: 'sonnet', group: 'llm-miner', seed: 1, values: { score: 100, defaulted: 2 } },
        { experiment: 'sonnet', group: 'llm-miner', seed: 2, values: { score: 200, defaulted: 0 } },
        { experiment: 'opus', group: 'llm-miner', seed: 1, values: { score: 130, defaulted: 1 } },
        { experiment: 'opus', group: 'llm-miner', seed: 2, values: { score: 210, defaulted: 0 } },
        // Seed 3 exists for opus only, so it counts in the mean but not in the pairing.
        { experiment: 'opus', group: 'llm-miner', seed: 3, values: { score: 500, defaulted: 9 } },
        {
          experiment: 'sonnet',
          group: 'llm-mill',
          seed: 1,
          values: { score: 10, defaulted: null },
        },
      ],
    );
    const [miner, mill] = table.split('\n\n');
    expect(miner).toMatch(/^llm-miner\s+sonnet \(n=2\)\s+opus \(n=3\)\s+Δ opus − sonnet \(n=2\)/);
    expect(row(miner as string, 'score')).toEqual(['150', '280', '20']);
    expect(row(miner as string, 'defaulted')).toEqual(['1', '3.33', '-0.50']);
    expect(mill).toMatch(/^llm-mill\s+sonnet \(n=1\)\s+opus \(n=0\)\s+Δ opus − sonnet \(n=0\)/);
    expect(row(mill as string, 'score')).toEqual(['10', '-', '-']);
    expect(row(mill as string, 'defaulted')).toEqual(['-', '-', '-']);
  });

  it('says so when there is nothing to compare', () => {
    expect(acrossTable(['a', 'b'], [])).toBe('no runs');
  });
});
