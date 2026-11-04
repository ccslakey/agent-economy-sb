import path from 'node:path';
import { PostgresStore } from '@agent-economy/api';
import { inferProvenance } from './provenance.ts';

// Gives every ended run that predates provenance the record that can still be proved for it (see
// inferProvenance), and leaves every run that has a record alone, so this can be rerun any time.
// The resolved model ids need no backfill: the provenance route reads them from the traces.
//
//   DATABASE_URL=postgres:///agent_economy node apps/runner/src/backfill-provenance.ts

const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error('set DATABASE_URL');
const repoDir = path.resolve(import.meta.dirname, '../../..');

const store = new PostgresStore(url);
await store.migrate();
let filled = 0;
for (const run of await store.listRuns()) {
  if (run.status !== 'ended' || run.provenance !== null) continue;
  const provenance = await inferProvenance({
    repoDir,
    createdAt: run.created_at,
    config: run.config,
  });
  await store.setProvenance(run.id, provenance);
  filled += 1;
  process.stdout.write(
    `${run.id} ${run.config.experiment_id} seed ${run.config.seed}: ${provenance.source_revision} ${provenance.prompt_variant}\n`,
  );
}
await store.close();
process.stdout.write(`${filled} run(s) backfilled\n`);
