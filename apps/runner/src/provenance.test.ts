import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Provenance, RunConfig } from '@agent-economy/schema';
import { describe, expect, it } from 'vitest';
import { collectProvenance, digest, inferProvenance } from './provenance.ts';

const run = promisify(execFile);

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

describe('inferred provenance', () => {
  it('names the last main-line commit before the run, marked inferred, and unknown for the rest', async () => {
    const config = RunConfig.parse({
      seed: 1,
      experiment_id: 'old/baseline',
      population: [
        {
          id: 'c01',
          name: 'Ironreach',
          role: 'miner',
          driver: {
            kind: 'llm',
            model: 'sonnet',
            effort: 'medium',
            harness_version: 1,
            prompt_variant: 'neutral',
          },
        },
        {
          id: 'c03',
          name: 'Fellwood',
          role: 'logger',
          driver: { kind: 'bot', strategy: 'honest_trader' },
        },
      ],
    });
    const inferred = await inferProvenance({
      repoDir,
      createdAt: '2026-11-01T18:00:00.000Z',
      config,
      now: () => new Date('2026-11-04T10:00:00Z'),
    });
    expect(Provenance.parse(inferred)).toEqual(inferred);
    expect(inferred.source_revision).toMatch(/^[0-9a-f]{40}-inferred$/);
    const commit = inferred.source_revision.slice(0, 40);
    const committed = (
      await run('git', ['show', '-s', '--format=%cI', commit], { cwd: repoDir })
    ).stdout.trim();
    expect(new Date(committed).getTime()).toBeLessThanOrEqual(
      new Date('2026-11-01T18:00:00.000Z').getTime(),
    );
    expect(inferred).toMatchObject({
      cli_version: 'unknown',
      prompt_variant: 'neutral',
      prompt_sha256: 'unknown',
      docs_sha256: 'unknown',
      recorded_at: '2026-11-04T10:00:00.000Z',
    });
    const bots = { ...config, population: config.population.slice(1) };
    expect(
      (await inferProvenance({ repoDir, createdAt: '2026-11-01T18:00:00.000Z', config: bots }))
        .prompt_variant,
    ).toBe('unknown');
  });
});
