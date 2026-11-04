import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fold, type RunMetrics } from '@agent-economy/engine';
import { type Event, expandSweep, ROLE_NAMES, Sweep, type SweepRun } from '@agent-economy/schema';
import { parse as parseYaml } from 'yaml';
import { acrossTable } from './across.ts';
import { claudeSpawner } from './claude.ts';
import { type ComparedRun, compareRuns, flatten } from './compare.ts';
import { createRun, drive, recordProvenance } from './drive.ts';
import { focalSeat, focalTable, seatOutcome } from './focal.ts';
import { fetchRetrying } from './http.ts';
import { collectProvenance, provenanceDifferences, type RunProvenance } from './provenance.ts';

// Run a sweep: every variant times every seed, a few runs at a time, then the comparison table.
// Rerunning a sweep skips any variant and seed that already has an ended run, so an interrupted
// night picks up where it stopped.
//
//   ADMIN_TOKEN=... node apps/runner/src/sweep.ts --api http://localhost:3000 --sweep configs/sweeps/m6-knobs.yaml [--concurrency 2]
//   ADMIN_TOKEN=... node apps/runner/src/sweep.ts --api http://localhost:3000 --compare m6-knobs
//   ADMIN_TOKEN=... node apps/runner/src/sweep.ts --api http://localhost:3000 --focal m7-focal
//
// Several experiments, comma separated, print one table across them: the first is the baseline,
// and each later one is paired with it by seed and by variant (or by focal seat). That is how two
// models or two months are compared. Every table ends with the provenance fields that differ
// among the runs it read, so a comparison never hides a change of software, prompt, or model id.
//
//   ADMIN_TOKEN=... node apps/runner/src/sweep.ts --api http://localhost:3000 --focal m7-focal,m7-focal-opus

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key?.startsWith('--') && value !== undefined) args.set(key.slice(2), value);
}
const api = args.get('api') ?? 'http://localhost:3000';
const adminToken = process.env.ADMIN_TOKEN;
if (adminToken === undefined) throw new Error('set ADMIN_TOKEN');
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

type Listing = {
  id: string;
  experiment_id: string;
  seed: number;
  status: string;
  created_at: string;
};
const admin = async <T>(route: string): Promise<T> => {
  const response = await fetchRetrying(`${api}${route}`, {
    headers: { 'x-admin-token': adminToken },
  });
  if (!response.ok) throw new Error(`GET ${route}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};
type CleanRun = ComparedRun & { id: string; experiment: string };
/**
 * Ended runs of the experiments that no bot had to finish. A run with a handoff is replayed, not
 * compared, and when a variant and seed was played more than once only the latest run counts,
 * so a replay supersedes the run it replaced instead of weighing twice.
 */
async function cleanRuns(experiments: readonly string[]): Promise<CleanRun[]> {
  const ended = (await admin<{ runs: Listing[] }>('/admin/runs')).runs.flatMap((r) => {
    const experiment = experiments.find((e) => r.experiment_id.startsWith(`${e}/`));
    return r.status === 'ended' && experiment !== undefined ? [{ ...r, experiment }] : [];
  });
  const withMetrics = await Promise.all(
    ended.map(async (r) => ({
      id: r.id,
      experiment: r.experiment,
      variant: r.experiment_id.slice(r.experiment.length + 1),
      seed: r.seed,
      created_at: r.created_at,
      metrics: await admin<RunMetrics>(`/admin/runs/${r.id}/metrics`),
    })),
  );
  const clean = withMetrics.filter(
    (r) =>
      r.metrics.bot_handoffs === 0 ||
      (log(
        `ignoring ${r.variant} seed ${r.seed} (${r.id}): ${r.metrics.bot_handoffs} bot handoffs`,
      ),
      false),
  );
  const latest = new Map<string, (typeof clean)[number]>();
  for (const r of clean) {
    const key = `${r.experiment}/${r.variant}:${r.seed}`;
    const held = latest.get(key);
    if (held === undefined || held.created_at < r.created_at) latest.set(key, r);
  }
  return clean.filter((r) => {
    const kept = latest.get(`${r.experiment}/${r.variant}:${r.seed}`);
    if (kept === r) return true;
    log(`superseding ${r.variant} seed ${r.seed} (${r.id}) by ${kept?.id}, played later`);
    return false;
  });
}

/** The provenance lines for a table: what differs among the runs it read, or one line saying nothing does. */
async function provenanceLines(runs: readonly CleanRun[]): Promise<string> {
  const records = await Promise.all(
    runs.map(async (r) => ({
      experiment: r.experiment,
      provenance: await admin<RunProvenance>(`/admin/runs/${r.id}/provenance`),
    })),
  );
  const lines = provenanceDifferences(records);
  return lines.length === 0
    ? 'provenance: same software, prompt, docs, and model ids across every run\n'
    : `${lines.map((l) => `provenance: ${l}`).join('\n')}\n`;
}

async function compare(experiments: readonly string[]): Promise<void> {
  const runs = await cleanRuns(experiments);
  const table =
    experiments.length === 1
      ? compareRuns(runs)
      : acrossTable(
          experiments,
          runs.map((r) => ({
            experiment: r.experiment,
            group: r.variant,
            seed: r.seed,
            values: flatten(r.metrics),
          })),
        );
  process.stdout.write(`${table}\n${await provenanceLines(runs)}`);
}

/**
 * The focal-company table. One experiment: each LLM seat against the bot in the same seat,
 * paired by seed. Several: each seat's LLM across the experiments, paired by seed, so the same
 * seat played by two models is read side by side with the bot population held fixed.
 */
async function focal(experiments: readonly string[]): Promise<void> {
  const runs = await cleanRuns(experiments);
  const folded = await Promise.all(
    runs.map(async (r) => {
      const { events } = await admin<{ events: Event[] }>(`/admin/runs/${r.id}/events`);
      const [started, ...rest] = events;
      if (started?.type !== 'run_started') throw new Error(`run ${r.id} has no run_started`);
      return { ...r, state: fold(started, rest) };
    }),
  );
  const table =
    experiments.length === 1
      ? focalTable(folded)
      : acrossTable(
          experiments,
          folded
            .flatMap((r) => {
              const seat = focalSeat(r.state.config);
              return seat === null ? [] : [{ r, seat }];
            })
            .sort(
              (a, b) =>
                ROLE_NAMES.indexOf(a.seat.role) - ROLE_NAMES.indexOf(b.seat.role) ||
                (a.seat.id < b.seat.id ? -1 : 1),
            )
            .map(({ r, seat }) => ({
              experiment: r.experiment,
              group: `${seat.role} ${seat.id} ${seat.name}`,
              seed: r.seed,
              values: { ...seatOutcome(r.state, seat.id) },
            })),
        );
  process.stdout.write(`${table}\n${await provenanceLines(runs)}`);
}

const compareOnly = args.get('compare');
const focalOnly = args.get('focal');
if (compareOnly !== undefined) {
  await compare(compareOnly.split(','));
} else if (focalOnly !== undefined) {
  await focal(focalOnly.split(','));
} else {
  const sweepPath = args.get('sweep');
  if (sweepPath === undefined) {
    throw new Error('pass --sweep <file>, --compare <experiment>, or --focal <experiment>');
  }
  const sweep = Sweep.parse(parseYaml(await readFile(sweepPath, 'utf8')));
  const concurrency = Number(args.get('concurrency') ?? 1);
  const variant = args.get('prompt') ?? 'neutral';
  const promptPath = path.resolve(import.meta.dirname, `../../../docs/prompts/${variant}.md`);
  const systemPrompt = await readFile(promptPath, 'utf8');
  // Collected once: every run of the sweep is played by this source, this CLI, and this prompt.
  const provenance = await collectProvenance({
    repoDir: path.resolve(import.meta.dirname, '../../..'),
    promptVariant: variant,
    promptPath,
    docsDir: path.resolve(import.meta.dirname, '../../../docs/agent'),
  });
  const done = await cleanRuns([sweep.experiment_id]);
  const queue: SweepRun[] = expandSweep(sweep).filter(
    (r) =>
      !done.some((d) => d.variant === r.variant && d.seed === r.seed) ||
      (log(`skipping ${r.config.experiment_id} seed ${r.seed}, already ended`), false),
  );
  log(`${queue.length} runs to play, ${concurrency} at a time`);
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const runId = await createRun(api, adminToken, next.config);
      await recordProvenance(api, adminToken, runId, provenance);
      const tag = `${next.config.experiment_id} seed ${next.seed} (${runId})`;
      log(`started ${tag}`);
      const result = await drive({
        api,
        adminToken,
        runId,
        spawner: claudeSpawner,
        systemPrompt,
        workDir: await mkdtemp(path.join(os.tmpdir(), 'agent-economy-')),
        sleep: (ms) => sleep(ms),
        log: (line) => log(`[${next?.variant} ${next?.seed}] ${line}`),
      });
      log(`ended ${tag} after ${result.turns} turns, ${result.sessions} sessions`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await compare([sweep.experiment_id]);
}
