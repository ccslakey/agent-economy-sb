import type { CompanyId, Event, RunConfig, RunId } from '@agent-economy/schema';

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

export interface Store {
  createRun(run: RunRow): Promise<void>;
  listRuns(): Promise<RunRow[]>;
  getRun(id: RunId): Promise<RunRow | null>;
  setRunStatus(id: RunId, status: RunStatus): Promise<void>;
  append(runId: RunId, events: readonly Event[]): Promise<void>;
  /** Events with seq greater than `afterSeq`, in seq order. */
  events(runId: RunId, afterSeq?: number): Promise<Event[]>;
  getNotes(runId: RunId, company: CompanyId): Promise<string>;
  putNotes(runId: RunId, company: CompanyId, text: string): Promise<void>;
}

export class MemoryStore implements Store {
  private readonly runs = new Map<RunId, RunRow>();
  private readonly log = new Map<RunId, Event[]>();
  private readonly notes = new Map<string, string>();

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
  async getNotes(runId: RunId, company: CompanyId): Promise<string> {
    return this.notes.get(`${runId}:${company}`) ?? '';
  }
  async putNotes(runId: RunId, company: CompanyId, text: string): Promise<void> {
    this.notes.set(`${runId}:${company}`, text);
  }
}
