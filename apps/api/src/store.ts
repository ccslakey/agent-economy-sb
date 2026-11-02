import type { CompanyId, Event, Plan, RunConfig, RunId } from '@agent-economy/schema';

// The only persistence boundary. Events are the source of truth; runs and notes are the two
// small tables beside them. MemoryStore backs tests, PostgresStore backs real runs.

export type RunStatus = 'running' | 'paused' | 'ended';

export type RunRow = {
  id: RunId;
  config: RunConfig;
  status: RunStatus;
  /** Bearer token per company. Admin only; never leaves the admin routes. */
  tokens: Record<string, string>;
};

/** One headless session: what was asked, what came back, and what it cost. */
export type TraceRow = {
  id: string;
  run_id: RunId;
  company: CompanyId;
  turn: number;
  round: number | null;
  kind: 'round' | 'farming';
  session_id: string | null;
  model: string | null;
  /** The CLI's full JSON result, or whatever the adapter captured on failure. */
  result: Record<string, unknown>;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
};

/** One tool call an agent made through the MCP server, with the turn and round the API saw when it arrived. */
export type ToolCallRow = {
  id: string;
  run_id: RunId;
  company: CompanyId;
  turn: number;
  round: number | null;
  tool: string;
  input: unknown;
  /** The text the tool returned, cut at `TOOL_OUTPUT_MAX_CHARS`; `output_chars` is the full length. */
  output: string;
  output_chars: number;
  duration_ms: number;
};

export const TOOL_OUTPUT_MAX_CHARS = 20_000;

/** One revision of a company's plan. Every PUT is kept, so the dashboard can show how it changed. */
export type PlanVersion = {
  run_id: RunId;
  company: CompanyId;
  turn: number;
  round: number | null;
  plan: Plan;
};

export interface Store {
  putPlan(version: PlanVersion): Promise<void>;
  /** The latest plan, or null before the first PUT. */
  getPlan(runId: RunId, company: CompanyId): Promise<Plan | null>;
  listPlans(runId: RunId, company?: CompanyId): Promise<PlanVersion[]>;
  putTrace(trace: TraceRow): Promise<void>;
  listTraces(runId: RunId, company?: CompanyId): Promise<TraceRow[]>;
  putToolCall(call: ToolCallRow): Promise<void>;
  listToolCalls(runId: RunId, company?: CompanyId): Promise<ToolCallRow[]>;
  createRun(run: RunRow): Promise<void>;
  listRuns(): Promise<RunRow[]>;
  getRun(id: RunId): Promise<RunRow | null>;
  setRunStatus(id: RunId, status: RunStatus): Promise<void>;
  append(runId: RunId, events: readonly Event[]): Promise<void>;
  /** Events with seq greater than `afterSeq`, in seq order. */
  events(runId: RunId, afterSeq?: number): Promise<Event[]>;
  /** The turn of the last event, or null before the first. Cheaper than loading the log for a listing. */
  lastTurn(runId: RunId): Promise<number | null>;
  getNotes(runId: RunId, company: CompanyId): Promise<string>;
  putNotes(runId: RunId, company: CompanyId, text: string): Promise<void>;
}

export class MemoryStore implements Store {
  private readonly runs = new Map<RunId, RunRow>();
  private readonly log = new Map<RunId, Event[]>();
  private readonly notes = new Map<string, string>();
  private readonly traces: TraceRow[] = [];
  private readonly calls: ToolCallRow[] = [];
  private readonly plans: PlanVersion[] = [];

  async putPlan(version: PlanVersion): Promise<void> {
    this.plans.push(structuredClone(version));
  }
  async getPlan(runId: RunId, company: CompanyId): Promise<Plan | null> {
    const latest = this.plans.findLast((p) => p.run_id === runId && p.company === company);
    return latest === undefined ? null : structuredClone(latest.plan);
  }
  async listPlans(runId: RunId, company?: CompanyId): Promise<PlanVersion[]> {
    return this.plans
      .filter((p) => p.run_id === runId && (company === undefined || p.company === company))
      .map((p) => structuredClone(p));
  }

  async putTrace(trace: TraceRow): Promise<void> {
    this.traces.push(structuredClone(trace));
  }
  async listTraces(runId: RunId, company?: CompanyId): Promise<TraceRow[]> {
    return this.traces
      .filter((t) => t.run_id === runId && (company === undefined || t.company === company))
      .map((t) => structuredClone(t));
  }

  async putToolCall(call: ToolCallRow): Promise<void> {
    this.calls.push(structuredClone(call));
  }
  async listToolCalls(runId: RunId, company?: CompanyId): Promise<ToolCallRow[]> {
    return this.calls
      .filter((c) => c.run_id === runId && (company === undefined || c.company === company))
      .map((c) => structuredClone(c));
  }

  async createRun(run: RunRow): Promise<void> {
    if (this.runs.has(run.id)) throw new Error(`run ${run.id} exists`);
    this.runs.set(run.id, { ...run });
    this.log.set(run.id, []);
  }
  async listRuns(): Promise<RunRow[]> {
    return [...this.runs.values()].map((r) => ({ ...r }));
  }
  async getRun(id: RunId): Promise<RunRow | null> {
    const run = this.runs.get(id);
    return run === undefined ? null : { ...run };
  }
  async setRunStatus(id: RunId, status: RunStatus): Promise<void> {
    const run = this.runs.get(id);
    if (run === undefined) throw new Error(`no run ${id}`);
    run.status = status;
  }
  async append(runId: RunId, events: readonly Event[]): Promise<void> {
    const log = this.log.get(runId);
    if (log === undefined) throw new Error(`no run ${runId}`);
    for (const event of events) {
      const last = log.at(-1);
      if (last !== undefined && event.seq !== last.seq + 1) {
        throw new Error(`seq ${event.seq} does not follow ${last.seq}`);
      }
      log.push(structuredClone(event));
    }
  }
  async events(runId: RunId, afterSeq = -1): Promise<Event[]> {
    return (this.log.get(runId) ?? [])
      .filter((e) => e.seq > afterSeq)
      .map((e) => structuredClone(e));
  }
  async lastTurn(runId: RunId): Promise<number | null> {
    return this.log.get(runId)?.at(-1)?.turn ?? null;
  }
  async getNotes(runId: RunId, company: CompanyId): Promise<string> {
    return this.notes.get(`${runId}:${company}`) ?? '';
  }
  async putNotes(runId: RunId, company: CompanyId, text: string): Promise<void> {
    this.notes.set(`${runId}:${company}`, text);
  }
}
