import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Provenance, RunConfig } from '@agent-economy/schema';

// What the runner records about itself at the start of every run: the git revision it runs
// from, the CLI it spawns, and a digest of the prompt and the docs the agents read. Anything that
// cannot be asked, for example git or the CLI missing on the machine, is recorded as `unknown`
// rather than failing the run.

const run = promisify(execFile);

async function ask(command: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run(command, args, { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** One sha256 over a set of named texts, in name order, so the same files always digest the same. */
export function digest(files: readonly { name: string; text: string }[]): string {
  const hash = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update(f.name);
    hash.update('\0');
    hash.update(f.text);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export type ProvenanceSources = {
  /** The git checkout the runner's source lives in. */
  repoDir: string;
  promptVariant: string;
  promptPath: string;
  /** The folder the docs tool serves; every file in it is digested. */
  docsDir: string;
  now?: () => Date;
};

export async function collectProvenance(sources: ProvenanceSources): Promise<Provenance> {
  const head = await ask('git', ['rev-parse', 'HEAD'], sources.repoDir);
  const changes = await ask(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    sources.repoDir,
  );
  const dirty = changes !== null && changes.length > 0;
  const cli = await ask('claude', ['--version'], sources.repoDir);
  const prompt = await readFile(sources.promptPath, 'utf8');
  const names = (await readdir(sources.docsDir)).sort();
  const docs = await Promise.all(
    names.map(async (name) => ({
      name,
      text: await readFile(path.join(sources.docsDir, name), 'utf8'),
    })),
  );
  return {
    source_revision: head === null ? 'unknown' : `${head}${dirty ? '-dirty' : ''}`,
    cli_version: cli === null || cli.length === 0 ? 'unknown' : cli,
    prompt_variant: sources.promptVariant,
    prompt_sha256: digest([{ name: path.basename(sources.promptPath), text: prompt }]),
    docs_sha256: digest(docs),
    recorded_at: (sources.now ?? (() => new Date()))().toISOString(),
  };
}

/**
 * Provenance for a run that was played before any was recorded, from what can still be proved:
 * the last commit on the main line before the run started, marked `-inferred` since the runner
 * may have been on a branch or a dirty tree; the prompt variant its LLM drivers were configured
 * with; and `unknown` for the CLI version and the digests, which nothing recorded.
 */
export async function inferProvenance(sources: {
  repoDir: string;
  createdAt: string;
  config: RunConfig;
  now?: () => Date;
}): Promise<Provenance> {
  const commit = await ask(
    'git',
    ['rev-list', '-1', `--before=${sources.createdAt}`, 'main'],
    sources.repoDir,
  );
  const variants = new Set(
    sources.config.population.flatMap((p) =>
      p.driver.kind === 'llm' ? [p.driver.prompt_variant] : [],
    ),
  );
  return {
    source_revision: commit === null || commit.length === 0 ? 'unknown' : `${commit}-inferred`,
    cli_version: 'unknown',
    prompt_variant: variants.size === 1 ? ([...variants][0] as string) : 'unknown',
    prompt_sha256: 'unknown',
    docs_sha256: 'unknown',
    recorded_at: (sources.now ?? (() => new Date()))().toISOString(),
  };
}
