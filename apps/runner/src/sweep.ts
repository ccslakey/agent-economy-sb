import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RunMetrics } from '@agent-economy/engine';
import { expandSweep, Sweep, type SweepRun } from '@agent-economy/schema';
import { parse as parseYaml } from 'yaml';
import { claudeSpawner } from './claude.ts';
import { type ComparedRun, compareRuns } from './compare.ts';
import { createRun, drive } from './drive.ts';

// Run a sweep: every variant times every seed, a few runs at a time, then the comparison table.
// Rerunning a sweep skips any variant and seed that already has an ended run, so an interrupted
// night picks up where it stopped.
//
//   ADMIN_TOKEN=... node apps/runner/src/sweep.ts --api http://localhost:3000 --sweep configs/sweeps/m6-knobs.yaml [--concurrency 2]
//   ADMIN_TOKEN=... node apps/runner/src/sweep.ts --api http://localhost:3000 --compare m6-knobs

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

type Listing = { id: string; experiment_id: string; seed: number; status: string };
const admin = async <T>(route: string): Promise<T> => {
  const response = await fetch(`${api}${route}`, { headers: { 'x-admin-token': adminToken } });
  if (!response.ok) throw new Error(`GET ${route}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};
const endedRuns = async (experiment: string): Promise<Listing[]> =>
  (await admin<{ runs: Listing[] }>('/admin/runs')).runs.filter(
    (r) => r.status === 'ended' && r.experiment_id.startsWith(`${experiment}/`),
  );

async function compare(experiment: string): Promise<void> {
  const runs = await endedRuns(experiment);
  const compared: ComparedRun[] = await Promise.all(
    runs.map(async (r) => ({
      variant: r.experiment_id.slice(experiment.length + 1),
      seed: r.seed,
      metrics: await admin<RunMetrics>(`/admin/runs/${r.id}/metrics`),
    })),
  );
  process.stdout.write(`${compareRuns(compared)}\n`);
}

const compareOnly = args.get('compare');
if (compareOnly !== undefined) {
  await compare(compareOnly);
} else {
  const sweepPath = args.get('sweep');
  if (sweepPath === undefined) throw new Error('pass --sweep <file> or --compare <experiment>');
  const sweep = Sweep.parse(parseYaml(await readFile(sweepPath, 'utf8')));
  const concurrency = Number(args.get('concurrency') ?? 1);
  const variant = args.get('prompt') ?? 'neutral';
  const systemPrompt = await readFile(
    path.resolve(import.meta.dirname, `../../../docs/prompts/${variant}.md`),
    'utf8',
  );
  const done = await endedRuns(sweep.experiment_id);
  const queue: SweepRun[] = expandSweep(sweep).filter(
    (r) =>
      !done.some((d) => d.experiment_id === r.config.experiment_id && d.seed === r.seed) ||
      (log(`skipping ${r.config.experiment_id} seed ${r.seed}, already ended`), false),
  );
  log(`${queue.length} runs to play, ${concurrency} at a time`);
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const runId = await createRun(api, adminToken, next.config);
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
  await compare(sweep.experiment_id);
}
