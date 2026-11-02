import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse as parseYaml } from 'yaml';
import { claudeSpawner } from './claude.ts';
import { createRun, drive, recordProvenance } from './drive.ts';
import { collectProvenance } from './provenance.ts';
import { formatReport } from './report.ts';

// Drive a run to the end through headless Claude Code.
//
//   ADMIN_TOKEN=... node apps/runner/src/run.ts --api http://localhost:3000 --config configs/m4.yaml
//   ADMIN_TOKEN=... node apps/runner/src/run.ts --api http://localhost:3000 --run r-...

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key?.startsWith('--') && value !== undefined) args.set(key.slice(2), value);
}
const api = args.get('api') ?? 'http://localhost:3000';
const adminToken = process.env.ADMIN_TOKEN;
if (adminToken === undefined) throw new Error('set ADMIN_TOKEN');

const variant = args.get('prompt') ?? 'neutral';
const promptPath = path.resolve(import.meta.dirname, `../../../docs/prompts/${variant}.md`);
const systemPrompt = await readFile(promptPath, 'utf8');

let runId = args.get('run');
if (runId === undefined) {
  const configPath = args.get('config');
  if (configPath === undefined) throw new Error('pass --run <id> or --config <file>');
  const loaded = parseYaml(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  runId = await createRun(api, adminToken, loaded);
  await recordProvenance(
    api,
    adminToken,
    runId,
    await collectProvenance({
      repoDir: path.resolve(import.meta.dirname, '../../..'),
      promptVariant: variant,
      promptPath,
      docsDir: path.resolve(import.meta.dirname, '../../../docs/agent'),
    }),
  );
  process.stdout.write(`created run ${runId}\n`);
}
const workDir = await mkdtemp(path.join(os.tmpdir(), 'agent-economy-'));
const result = await drive({
  api,
  adminToken,
  runId,
  spawner: claudeSpawner,
  systemPrompt,
  workDir,
  sleep: (ms) => sleep(ms),
  log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
  ...(args.has('quota-wait-ms') ? { quotaWaitMs: Number(args.get('quota-wait-ms')) } : {}),
});
process.stdout.write(
  `run ${runId} ended after ${result.turns} turns, ${result.sessions} sessions${result.replaced.length > 0 ? `, replaced ${result.replaced.join(', ')}` : ''}\n`,
);
process.stdout.write(`${formatReport(result.report)}\n`);
