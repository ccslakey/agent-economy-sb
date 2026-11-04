import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Provenance } from '@agent-economy/schema';

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

/** What the provenance route serves for a run: the recorded fields, if any, plus the resolved model ids. */
export type RunProvenance = Partial<Provenance> & { resolved_models?: Record<string, string[]> };

export type ProvenanceOf = { experiment: string; provenance: RunProvenance };

const FIELDS = [
  'source_revision',
  'cli_version',
  'prompt_variant',
  'prompt_sha256',
  'docs_sha256',
  'resolved_models',
] as const;

/** `m7-focal ×10, m7-focal-opus ×3`: which experiments, and how many of their runs, share a value. */
function byExperiment(runs: readonly ProvenanceOf[]): string {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.experiment, (counts.get(r.experiment) ?? 0) + 1);
  return [...counts].map(([e, n]) => `${e} ×${n}`).join(', ');
}

/**
 * One line per provenance field whose value is not the same across the runs, naming each value
 * and the runs that carry it, plus a line for any run played from a dirty source tree. Empty
 * when every run was played by the same software, prompt, docs, and model ids. A run with no
 * record shows as `unrecorded`, and a field no run recorded still prints, so a table over
 * pre-provenance runs never reads as a verified match.
 */
export function provenanceDifferences(runs: readonly ProvenanceOf[]): string[] {
  const lines: string[] = [];
  for (const field of FIELDS) {
    const values = new Map<string, ProvenanceOf[]>();
    for (const r of runs) {
      const raw = r.provenance[field];
      const value =
        raw === undefined || (typeof raw === 'object' && Object.keys(raw).length === 0)
          ? 'unrecorded'
          : typeof raw === 'string'
            ? raw
            : Object.entries(raw)
                .map(([k, ids]) => `${k}=${ids.join('+')}`)
                .join(' ');
      values.set(value, [...(values.get(value) ?? []), r]);
    }
    if (values.size < 2 && !values.has('unrecorded')) continue;
    lines.push(
      values.size < 2
        ? `${field} unrecorded (${byExperiment(runs)})`
        : `${field} differs: ${[...values].map(([v, rs]) => `${v} (${byExperiment(rs)})`).join(' | ')}`,
    );
  }
  const dirty = runs.filter((r) => r.provenance.source_revision?.endsWith('-dirty'));
  if (dirty.length > 0) lines.push(`dirty source tree: ${byExperiment(dirty)}`);
  return lines;
}
