import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Provenance } from '@agent-economy/schema';
import { describe, expect, it } from 'vitest';
import { collectProvenance, digest, provenanceDifferences } from './provenance.ts';

const repoDir = path.resolve(import.meta.dirname, '../../..');
const docsDir = path.join(repoDir, 'docs/agent');
const promptPath = path.join(repoDir, 'docs/prompts/neutral.md');

describe('provenance', () => {
  it('digests a set of files the same in any order and differently for any change', () => {
    const a = digest([
      { name: 'rules.md', text: 'one' },
      { name: 'api.md', text: 'two' },
    ]);
    const b = digest([
      { name: 'api.md', text: 'two' },
      { name: 'rules.md', text: 'one' },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      digest([
        { name: 'api.md', text: 'two' },
        { name: 'rules.md', text: 'one.' },
      ]),
    ).not.toBe(a);
    expect(
      digest([
        { name: 'api.md', text: 'two' },
        { name: 'rules.txt', text: 'one' },
      ]),
    ).not.toBe(a);
  });

  it('records this checkout, the prompt, and every agent doc', async () => {
    const recorded = await collectProvenance({
      repoDir,
      promptVariant: 'neutral',
      promptPath,
      docsDir,
      now: () => new Date('2026-11-02T10:00:00Z'),
    });
    expect(Provenance.parse(recorded)).toEqual(recorded);
    expect(recorded.source_revision).toMatch(/^[0-9a-f]{40}(-dirty)?$/);
    expect(recorded.prompt_variant).toBe('neutral');
    expect(recorded.recorded_at).toBe('2026-11-02T10:00:00.000Z');
    const names = (await readdir(docsDir)).sort();
    const docs = await Promise.all(
      names.map(async (name) => ({
        name,
        text: await readFile(path.join(docsDir, name), 'utf8'),
      })),
    );
    expect(names).toContain('rules.md');
    expect(recorded.docs_sha256).toBe(digest(docs));
    expect(recorded.prompt_sha256).toBe(
      digest([{ name: 'neutral.md', text: await readFile(promptPath, 'utf8') }]),
    );
  });

  it('records unknown for a source and CLI it cannot ask', async () => {
    const recorded = await collectProvenance({
      repoDir: path.join(repoDir, 'docs'),
      promptVariant: 'neutral',
      promptPath,
      docsDir,
    });
    // docs/ is inside the checkout, so git still answers; the CLI answer depends on the machine.
    expect(recorded.source_revision).toMatch(/^([0-9a-f]{40}(-dirty)?|unknown)$/);
    expect(recorded.cli_version.length).toBeGreaterThan(0);
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

  it('still names a field that no run recorded, so old runs never read as a verified match', () => {
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
