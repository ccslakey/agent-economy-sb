import path from 'node:path';
import { PostgresStore } from './postgres.ts';
import { buildServer } from './server.ts';

// Entry point. Needs DATABASE_URL and ADMIN_TOKEN; PORT defaults to 3000.

const databaseUrl = process.env.DATABASE_URL;
const adminToken = process.env.ADMIN_TOKEN;
if (databaseUrl === undefined || adminToken === undefined) {
  throw new Error('set DATABASE_URL and ADMIN_TOKEN');
}

const store = new PostgresStore(databaseUrl);
await store.migrate();
await store.listRuns();
if (store.skippedRuns.length > 0) {
  process.stderr.write(
    `skipping ${store.skippedRuns.length} run(s) whose stored config no longer parses: ${store.skippedRuns.join(', ')}\n`,
  );
}
const app = await buildServer({
  store,
  adminToken,
  docsDir: path.resolve(import.meta.dirname, '../../../docs/agent'),
});
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
