import { randomUUID } from 'node:crypto';
import { PostgresStore } from '@agent-economy/api';
import { RunId } from '@agent-economy/schema';
import { playBots, roster } from './play.ts';

// Plays one bot game and stores it as a finished run, so the inspector has something to show.
//
//   DATABASE_URL=postgres:///agent_economy node apps/runner/src/seed-db.ts [turns] [seed]

const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error('set DATABASE_URL');
const turns = Number(process.argv[2] ?? 20);
const seed = Number(process.argv[3] ?? 1);

const config = roster(
  (role, slot) => {
    if (role === 'smelter' && slot === 1) return 'defector';
    if (role === 'miner' && slot === 1) return 'greedy_producer';
    if (role === 'mill' && slot === 1) return 'passive';
    if (role === 'logger' && slot === 1) return 'random';
    return 'honest_trader';
  },
  { experiment_id: 'seeded-bots', knobs: { horizon: { kind: 'fixed', last_turn: turns } } },
  seed,
);
const runId = RunId.parse(`r-${randomUUID()}`);
const played = playBots(config, runId);

const store = new PostgresStore(url);
await store.migrate();
await store.createRun({
  id: runId,
  config,
  status: 'ended',
  tokens: Object.fromEntries(config.population.map((p) => [p.id, randomUUID()])),
});
await store.append(runId, played.log);
await store.close();
process.stdout.write(`${runId} ${played.log.length} events over ${played.state.turn} turns\n`);
