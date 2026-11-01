import { CompanyId, Event, Plan, RunConfig, RunId } from '@agent-economy/schema';
import { type Generated, type JSONColumnType, Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import type { PlanVersion, RunRow, RunStatus, Store, TraceRow } from './store.ts';

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

type TracesTable = {
  id: string;
  run_id: string;
  company_id: string;
  turn: number;
  round: number | null;
  kind: string;
  session_id: string | null;
  model: string | null;
  result: JSONColumnType<Record<string, unknown>>;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
  created_at: Generated<Date>;
};

type PlansTable = {
  id: Generated<number>;
  run_id: string;
  company_id: string;
  turn: number;
  round: number | null;
  plan: JSONColumnType<Record<string, unknown>>;
  created_at: Generated<Date>;
};

type Database = {
  runs: RunsTable;
  events: EventsTable;
  notes: NotesTable;
  agent_traces: TracesTable;
  plan_versions: PlansTable;
};

const Status = z.enum(['running', 'paused', 'ended']);
const Trace = z.object({
  id: z.string(),
  run_id: RunId,
  company: CompanyId,
  turn: z.number().int(),
  round: z.number().int().nullable(),
  kind: z.enum(['round', 'farming']),
  session_id: z.string().nullable(),
  model: z.string().nullable(),
  result: z.record(z.string(), z.unknown()),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  cost_usd: z.number(),
  duration_ms: z.number().int(),
});
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
    await sql`
      create table if not exists agent_traces (
        id text primary key,
        run_id text not null references runs(id),
        company_id text not null,
        turn integer not null,
        round integer,
        kind text not null,
        session_id text,
        model text,
        result jsonb not null,
        tokens_in integer not null,
        tokens_out integer not null,
        cost_usd double precision not null,
        duration_ms integer not null,
        created_at timestamptz not null default now()
      )`.execute(this.db);
    await sql`
      create table if not exists plan_versions (
        id serial primary key,
        run_id text not null references runs(id),
        company_id text not null,
        turn integer not null,
        round integer,
        plan jsonb not null,
        created_at timestamptz not null default now()
      )`.execute(this.db);
  }

  async putPlan(version: PlanVersion): Promise<void> {
    await this.db
      .insertInto('plan_versions')
      .values({
        run_id: version.run_id,
        company_id: version.company,
        turn: version.turn,
        round: version.round,
        plan: JSON.stringify(version.plan),
      })
      .execute();
  }

  async getPlan(runId: RunId, company: CompanyId): Promise<Plan | null> {
    const row = await this.db
      .selectFrom('plan_versions')
      .select('plan')
      .where('run_id', '=', runId)
      .where('company_id', '=', company)
      .orderBy('id', 'desc')
      .executeTakeFirst();
    return row === undefined ? null : Plan.parse(row.plan);
  }

  async listPlans(runId: RunId, company?: CompanyId): Promise<PlanVersion[]> {
    let query = this.db.selectFrom('plan_versions').selectAll().where('run_id', '=', runId);
    if (company !== undefined) query = query.where('company_id', '=', company);
    const rows = await query.orderBy('id').execute();
    return rows.map((row) => ({
      run_id: RunId.parse(row.run_id),
      company: CompanyId.parse(row.company_id),
      turn: row.turn,
      round: row.round,
      plan: Plan.parse(row.plan),
    }));
  }

  async putTrace(trace: TraceRow): Promise<void> {
    await this.db
      .insertInto('agent_traces')
      .values({
        id: trace.id,
        run_id: trace.run_id,
        company_id: trace.company,
        turn: trace.turn,
        round: trace.round,
        kind: trace.kind,
        session_id: trace.session_id,
        model: trace.model,
        result: JSON.stringify(trace.result),
        tokens_in: trace.tokens_in,
        tokens_out: trace.tokens_out,
        cost_usd: trace.cost_usd,
        duration_ms: trace.duration_ms,
      })
      .execute();
  }

  async lastTurn(runId: RunId): Promise<number | null> {
    const row = await this.db
      .selectFrom('events')
      .select('turn')
      .where('run_id', '=', runId)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.turn ?? null;
  }

  async listTraces(runId: RunId, company?: CompanyId): Promise<TraceRow[]> {
    let query = this.db.selectFrom('agent_traces').selectAll().where('run_id', '=', runId);
    if (company !== undefined) query = query.where('company_id', '=', company);
    const rows = await query.orderBy('created_at').execute();
    return rows.map((row) => Trace.parse({ ...row, company: row.company_id }));
  }

  /** Test hook: overwrite a stored config without validation, to simulate a run saved by an older schema. */
  async rawUpdateConfig(id: RunId, config: unknown): Promise<void> {
    await this.db
      .updateTable('runs')
      .set({ config: JSON.stringify(config) })
      .where('id', '=', id)
      .execute();
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

  /** Runs whose stored config no longer parses, for example after a schema change, are skipped and counted here. */
  skippedRuns: string[] = [];

  async listRuns(): Promise<RunRow[]> {
    const rows = await this.db.selectFrom('runs').selectAll().orderBy('created_at').execute();
    const out: RunRow[] = [];
    this.skippedRuns = [];
    for (const row of rows) {
      const parsed = RunConfig.safeParse(row.config);
      if (parsed.success) out.push(toRunRow(row));
      else this.skippedRuns.push(row.id);
    }
    return out;
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
