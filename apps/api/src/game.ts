import {
  apply,
  fold,
  observe,
  type Rng,
  type RoundNews,
  rngFor,
  start,
  step,
} from '@agent-economy/engine';
import {
  type Action,
  type ActionError,
  type ActionResult,
  type Company,
  type CompanyId,
  type ContractId,
  type Event,
  type EventOf,
  type EventPayload,
  type EventType,
  eventId,
  type Message,
  type Observation,
  parseActionBatch,
  type RunConfig,
  type RunId,
  type RunState,
} from '@agent-economy/schema';

// One live run. Owns the state, the in-memory log, the tool-call budget per company per round,
// and the round clock. Every mutation goes through `commit`, which persists before it returns,
// and through `serial`, so concurrent requests never interleave on one run.

export type Clock = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type GameOptions = {
  persist: (events: readonly Event[]) => Promise<void>;
  clock?: Clock;
  rng?: (seed: number, turn: number) => Rng;
};

export type SubmitOutcome =
  | { ok: true; results: ActionResult[] }
  | { ok: false; error: ActionError };

/** The body of an event the API itself records: type, payload, and actor, with the envelope added by the game. */
export type SystemBody = {
  [K in EventType]: { type: K; payload: EventPayload<K>; actor: CompanyId | null };
}[EventType];

export class Game {
  state: RunState;
  readonly log: Event[];
  private news: RoundNews = { contracts_changed: [], messages: [] };
  private calls = new Map<CompanyId, number>();
  /** Companies that sent an empty batch this round. The engine records nothing for an empty batch, so the game remembers it. */
  private emptyBatches = new Set<CompanyId>();
  private timer: unknown = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly clock: Clock;
  private readonly rngFor: (seed: number, turn: number) => Rng;

  readonly started: EventOf<'run_started'>;
  private readonly options: GameOptions;

  constructor(started: EventOf<'run_started'>, rest: readonly Event[], options: GameOptions) {
    this.started = started;
    this.options = options;
    this.state = fold(started, rest);
    this.log = [started, ...rest];
    this.clock = options.clock ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      // Node's clearTimeout wants its own handle type; this default clock only ever sees its own.
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.rngFor = options.rng ?? rngFor;
    this.armDeadline();
  }

  /** A new run: writes run_started and the first round_opened, then returns the live game. */
  static async create(config: RunConfig, runId: RunId, options: GameOptions): Promise<Game> {
    const started = start(config, runId);
    await options.persist([started]);
    const game = new Game(started, [], options);
    await game.commit([game.marker({ type: 'round_opened', payload: {}, actor: null })]);
    return game;
  }

  get id(): RunId {
    return this.state.run_id;
  }

  /** Re-read state after a commit. TypeScript keeps a narrowing on `this.state` across calls, so this breaks it. */
  private current(): RunState {
    return this.state;
  }

  /** An event the engine does not produce, stamped with the next seq and the current turn and round. */
  private marker(body: SystemBody): Event {
    const seq = this.state.seq + 1;
    return {
      id: eventId(this.state.run_id, seq),
      run_id: this.state.run_id,
      turn: this.state.turn,
      round: this.state.phase.kind === 'round' ? this.state.phase.round : null,
      seq,
      ...body,
    };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async commit(events: readonly Event[]): Promise<void> {
    if (events.length === 0) return;
    await this.options.persist(events);
    for (const event of events) {
      this.state = apply(this.state, event);
      this.log.push(event);
    }
  }

  company(id: CompanyId): Company | undefined {
    return this.state.companies[id];
  }

  budgetLeft(company: CompanyId): number {
    return Math.max(0, this.state.config.limits.round_tool_calls - (this.calls.get(company) ?? 0));
  }

  /** Spend one tool call. Null when the call may proceed, ROUND_CLOSED otherwise. */
  spend(company: CompanyId): ActionError | null {
    if (this.state.phase.kind !== 'round') {
      return { code: 'ROUND_CLOSED', reason: `no round is open (${this.state.phase.kind})` };
    }
    if (this.budgetLeft(company) === 0) {
      return { code: 'ROUND_CLOSED', reason: 'tool-call budget for this round is spent' };
    }
    this.calls.set(company, (this.calls.get(company) ?? 0) + 1);
    return null;
  }

  observation(company: Company): Observation {
    return observe(this.state, company, this.news, this.budgetLeft(company.id));
  }

  /** POST /v1/actions. Parses at the boundary, hands valid actions to the engine, and maps results back to batch order. */
  submit(company: CompanyId, body: unknown): Promise<SubmitOutcome> {
    return this.serial(async () => {
      if (this.emptyBatches.has(company)) {
        return {
          ok: false,
          error: { code: 'BATCH_ALREADY_SUBMITTED', reason: 'one batch per round' },
        };
      }
      const parsed = parseActionBatch(body);
      if (parsed.length === 0 && this.state.phase.kind === 'round') this.emptyBatches.add(company);
      const valid: Action[] = [];
      const positions: number[] = [];
      parsed.forEach((p, i) => {
        if (p.ok) {
          valid.push(p.action);
          positions.push(i);
        }
      });
      const events = step(
        this.state,
        { kind: 'submit', company, actions: valid },
        this.rngFor(this.state.config.seed, this.state.turn),
      );
      await this.commit(events);
      const results: ActionResult[] = parsed.map((p) =>
        p.ok ? { ok: true } : { ok: false, code: p.error.code, reason: p.error.reason },
      );
      for (const event of events) {
        if (event.type === 'action_rejected') {
          const at = positions[event.payload.index];
          if (at !== undefined) {
            results[at] = { ok: false, code: event.payload.code, reason: event.payload.reason };
          }
        }
      }
      await this.maybeAdvance();
      return { ok: true, results };
    });
  }

  /** Append an event the engine does not produce, such as a bug report. */
  record(body: SystemBody): Promise<void> {
    return this.serial(() => this.commit([this.marker(body)]));
  }

  /** Resolve the open round. If that ends the turn, run the operations step too. */
  advance(): Promise<Event[]> {
    return this.serial(() => this.advanceNow());
  }

  pause(reason: string): Promise<void> {
    return this.serial(async () => {
      if (this.state.phase.kind !== 'round') return;
      this.disarm();
      await this.commit([this.marker({ type: 'run_paused', payload: { reason }, actor: null })]);
    });
  }

  resume(): Promise<void> {
    return this.serial(async () => {
      if (this.state.phase.kind !== 'paused') return;
      await this.commit([this.marker({ type: 'run_resumed', payload: {}, actor: null })]);
      this.armDeadline();
    });
  }

  private async advanceNow(): Promise<Event[]> {
    if (this.state.phase.kind !== 'round') return [];
    this.disarm();
    const rng = this.rngFor(this.state.config.seed, this.state.turn);
    const resolved = step(this.state, { kind: 'resolve_round' }, rng);
    await this.commit(resolved);
    let events = resolved;
    if (this.current().phase.kind === 'operations') {
      const ops = step(this.state, { kind: 'operations' }, rng);
      await this.commit(ops);
      events = [...resolved, ...ops];
    }
    this.news = newsFrom(events);
    this.calls.clear();
    this.emptyBatches.clear();
    this.armDeadline();
    return events;
  }

  private async maybeAdvance(): Promise<void> {
    if (this.state.phase.kind !== 'round') return;
    const waiting = Object.values(this.state.companies).filter(
      (c) =>
        c.standing.kind === 'solvent' &&
        !this.state.submitted.includes(c.id) &&
        !this.emptyBatches.has(c.id) &&
        this.budgetLeft(c.id) > 0,
    );
    if (waiting.length === 0) await this.advanceNow();
  }

  private armDeadline(): void {
    this.disarm();
    if (this.state.phase.kind !== 'round') return;
    const ms = this.state.config.limits.round_wall_clock_seconds * 1000;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.advance();
    }, ms);
  }

  private disarm(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  close(): void {
    this.disarm();
  }
}

/** What agents are told about at the next observation: contract ids touched and messages delivered. */
export function newsFrom(events: readonly Event[]): RoundNews {
  const contracts = new Set<ContractId>();
  const messages: Message[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'contract_proposed':
      case 'contract_accepted':
      case 'contract_rejected':
      case 'contract_withdrawn':
      case 'contract_expired':
      case 'delivery_made':
      case 'payment_made':
      case 'escrow_deposited':
      case 'escrow_released':
      case 'escrow_refunded':
      case 'contract_completed':
      case 'contract_defaulted':
      case 'contract_cured':
        contracts.add(e.payload.contract);
        break;
      default:
        break;
    }
    if (
      (e.type === 'message_posted' || e.type === 'dm_sent') &&
      e.actor !== null &&
      e.round !== null
    ) {
      messages.push({
        turn: e.turn,
        round: e.round,
        from: e.actor,
        channel: e.type === 'dm_sent' ? { kind: 'dm', to: e.payload.to } : { kind: 'public' },
        text: e.payload.text,
      });
    }
  }
  return { contracts_changed: [...contracts].sort(), messages };
}
