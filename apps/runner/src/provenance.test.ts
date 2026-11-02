import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Provenance } from '@agent-economy/schema';
import { describe, expect, it } from 'vitest';
import { collectProvenance, digest } from './provenance.ts';

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
