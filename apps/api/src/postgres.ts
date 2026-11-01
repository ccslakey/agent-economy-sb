import { type CompanyId, Event, RunConfig, RunId } from '@agent-economy/schema';
import { type Generated, type JSONColumnType, Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import type { RunRow, RunStatus, Store } from './store.ts';

// Postgres through Kysely: typed SQL with the event log in plain sight. Rows are parsed back
// through the schema package on the way out, so a bad row fails loudly instead of folding.

type RunsTable = {
  id: string;
  config: JSONColumnType<Record<string, unknown>>;
  seed: number;
  experiment_id: string;
  status: string;
  tokens: JSONColumnType<Record<string, unknown>>;
  created_at: Generated<Date>;
  ended_at: Date | null;
};

type EventsTable = {
  id: string;
  run_id: string;
  turn: number;
  round: number | null;
  seq: number;
  type: string;
  actor: string | null;
  payload: JSONColumnType<Record<string, unknown>>;
  created_at: Generated<Date>;
};

type NotesTable = {
  run_id: string;
  company_id: string;
  text: string;
  updated_at: Generated<Date>;
};

type Database = { runs: RunsTable; events: EventsTable; notes: NotesTable };

const Status = z.enum(['running', 'paused', 'ended']);
const Tokens = z.record(z.string(), z.string());

export class PostgresStore implements Store {
  private readonly db: Kysely<Database>;

  constructor(connectionString: string) {
    this.db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    });
  }

  /** Idempotent: safe to run on every start. */
  async migrate(): Promise<void> {
    await sql`
      create table if not exists runs (
        id text primary key,
        config jsonb not null,
        seed integer not null,
        experiment_id text not null,
        status text not null,
        tokens jsonb not null,
        created_at timestamptz not null default now(),
        ended_at timestamptz
      )`.execute(this.db);
    await sql`
      create table if not exists events (
        id text primary key,
        run_id text not null references runs(id),
        turn integer not null,
        round integer,
        seq integer not null,
        type text not null,
        actor text,
        payload jsonb not null,
        created_at timestamptz not null default now(),
        unique (run_id, seq)
      )`.execute(this.db);
    await sql`
      create table if not exists notes (
        run_id text not null references runs(id),
        company_id text not null,
        text text not null,
        updated_at timestamptz not null default now(),
        primary key (run_id, company_id)
      )`.execute(this.db);
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }

  async createRun(run: RunRow): Promise<void> {
    await this.db
      .insertInto('runs')
      .values({
        id: run.id,
        config: JSON.stringify(run.config),
        seed: run.config.seed,
        experiment_id: run.config.experiment_id,
        status: run.status,
        tokens: JSON.stringify(run.tokens),
      })
      .execute();
  }

  async listRuns(): Promise<RunRow[]> {
    const rows = await this.db.selectFrom('runs').selectAll().orderBy('created_at').execute();
    return rows.map(toRunRow);
  }

  async getRun(id: RunId): Promise<RunRow | null> {
    const row = await this.db
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? null : toRunRow(row);
  }

  async setRunStatus(id: RunId, status: RunStatus): Promise<void> {
    await this.db
      .updateTable('runs')
      .set({ status, ended_at: status === 'ended' ? new Date() : null })
      .where('id', '=', id)
      .execute();
  }

  async append(runId: RunId, events: readonly Event[]): Promise<void> {
    if (events.length === 0) return;
    await this.db
      .insertInto('events')
      .values(
        events.map((e) => ({
          id: e.id,
          run_id: runId,
          turn: e.turn,
          round: e.round,
          seq: e.seq,
          type: e.type,
          actor: e.actor,
          payload: JSON.stringify(e.payload),
        })),
      )
      .execute();
  }

  async events(runId: RunId, afterSeq = -1): Promise<Event[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'run_id', 'turn', 'round', 'seq', 'type', 'actor', 'payload'])
      .where('run_id', '=', runId)
      .where('seq', '>', afterSeq)
      .orderBy('seq')
      .execute();
    return rows.map((row) => Event.parse(row));
  }

  async getNotes(runId: RunId, company: CompanyId): Promise<string> {
    const row = await this.db
      .selectFrom('notes')
      .select('text')
      .where('run_id', '=', runId)
      .where('company_id', '=', company)
      .executeTakeFirst();
    return row?.text ?? '';
  }

  async putNotes(runId: RunId, company: CompanyId, text: string): Promise<void> {
    await this.db
      .insertInto('notes')
      .values({ run_id: runId, company_id: company, text })
      .onConflict((oc) =>
        oc.columns(['run_id', 'company_id']).doUpdateSet({ text, updated_at: new Date() }),
      )
      .execute();
  }
}

function toRunRow(row: { id: string; config: unknown; status: string; tokens: unknown }): RunRow {
  return {
    id: RunId.parse(row.id),
    config: RunConfig.parse(row.config),
    status: Status.parse(row.status),
    tokens: Tokens.parse(row.tokens),
  };
}
