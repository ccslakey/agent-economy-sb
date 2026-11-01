import { spawn } from 'node:child_process';
import os from 'node:os';
import { Event, type RunMoments } from '@agent-economy/schema';
import { interpret } from './claude.ts';
import { check, digest, parse, prompt } from './narrate.ts';

// Write a run's notable moments through headless Claude Code and store them on the API.
//
//   ADMIN_TOKEN=... node apps/runner/src/moments.ts --api http://localhost:3000 --run r-... [--model opus] [--effort medium]

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key?.startsWith('--') && value !== undefined) args.set(key.slice(2), value);
}
const api = args.get('api') ?? 'http://localhost:3000';
const runId = args.get('run');
const model = args.get('model') ?? 'opus';
const effort = args.get('effort') ?? 'medium';
const adminToken = process.env.ADMIN_TOKEN;
if (adminToken === undefined) throw new Error('set ADMIN_TOKEN');
if (runId === undefined) throw new Error('pass --run <id>');

const headers = { 'x-admin-token': adminToken, 'content-type': 'application/json' };
const response = await fetch(`${api}/admin/runs/${runId}/events`, { headers });
if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
const { events } = (await response.json()) as { events: unknown[] };
const [started, ...rest] = events.map((e) => Event.parse(e));
if (started?.type !== 'run_started') throw new Error('run has no events');

const text = digest(started, rest);
process.stdout.write(`digest: ${text.split('\n').length} lines\n`);

const result = await new Promise<ReturnType<typeof interpret>>((resolve) => {
  const startedAt = Date.now();
  const child = spawn(
    'claude',
    [
      '-p',
      prompt(text),
      '--model',
      model,
      '--effort',
      effort,
      '--tools',
      '',
      '--output-format',
      'json',
    ],
    { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) =>
    resolve({ ok: false, kind: 'error', message: error.message, raw: {}, durationMs: 0 }),
  );
  child.on('close', (code) => resolve(interpret(stdout, stderr, code, Date.now() - startedAt)));
});
if (!result.ok) throw new Error(`claude failed (${result.kind}): ${result.message}`);

const raw = parse(result.result);
const moments = check(raw, rest);
const cited = raw.reduce((sum, m) => sum + m.events.length, 0);
const kept = moments.reduce((sum, m) => sum + m.events.length, 0);
process.stdout.write(
  `${raw.length} moments written, ${moments.length} kept; ${kept} of ${cited} citations resolve · $${result.costUsd.toFixed(2)}\n`,
);

const body: RunMoments = { generated_at: new Date().toISOString(), model, moments };
const put = await fetch(`${api}/admin/runs/${runId}/moments`, {
  method: 'PUT',
  headers,
  body: JSON.stringify(body),
});
if (!put.ok) throw new Error(`${put.status} ${await put.text()}`);
for (const m of moments) {
  process.stdout.write(
    `\nT${m.from_turn}${m.to_turn === m.from_turn ? '' : `–${m.to_turn}`}: ${m.text}\n  ${m.events.join(', ')}\n`,
  );
}
