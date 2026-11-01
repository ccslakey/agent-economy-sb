import {
  apply,
  initialState,
  newsFrom,
  observe,
  type RoundNews,
  reputationOf,
  rngFor,
  scoreOf,
  start,
  step,
} from '@agent-economy/engine';
import {
  type BotStrategy,
  type CompanyId,
  type Event,
  type EventOf,
  type Role,
  RunConfig,
  type RunConfigInput,
  RunId,
  type RunState,
} from '@agent-economy/schema';
import { BOTS, type BotMemory, freshMemory } from './bots.ts';

// Plays a bot-only run in process against the engine. Bots see exactly what the API would show
// them, so the same bots can later be pointed at the HTTP API without changing a decision.

export type PlayResult = { started: EventOf<'run_started'>; log: Event[]; state: RunState };

export function playBots(config: RunConfig, runId = 'bots', maxTurns = 500): PlayResult {
  const started = start(config, RunId.parse(runId));
  let state = initialState(started);
  const log: Event[] = [started];
  let news: RoundNews = { contracts_changed: [], messages: [] };
  const memories = new Map<CompanyId, BotMemory>();
  const strategies = new Map<CompanyId, BotStrategy>();
  for (const entry of config.population) {
    if (entry.driver.kind === 'bot') strategies.set(entry.id, entry.driver.strategy);
    memories.set(entry.id, freshMemory());
  }
  const commit = (events: Event[]): void => {
    for (const event of events) {
      state = apply(state, event);
      log.push(event);
    }
  };

  while (state.phase.kind !== 'ended' && state.turn <= maxTurns) {
    const rng = rngFor(config.seed, state.turn);
    while (state.phase.kind === 'round') {
      const round = state.phase.round;
      for (const company of Object.values(state.companies).sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (company.standing.kind !== 'solvent') continue;
        const strategy = strategies.get(company.id);
        const memory = memories.get(company.id);
        if (strategy === undefined || memory === undefined) continue;
        const observation = observe(state, company, news, config.limits.round_tool_calls);
        const contracts = Object.values(state.contracts).filter(
          (k) => k.proposer === company.id || k.counterparty === company.id,
        );
        const botRng = (purpose: string) => rng(`${company.id}:${round}:${purpose}`);
        const actions = BOTS[strategy](
          { observation, contracts, prices: state.config.economy.reference_prices },
          memory,
          botRng,
        );
        commit(step(state, { kind: 'submit', company: company.id, actions }, rng));
      }
      const resolved = step(state, { kind: 'resolve_round' }, rng);
      commit(resolved);
      news = newsFrom(resolved);
    }
    if (state.phase.kind === 'operations') {
      const ops = step(state, { kind: 'operations' }, rng);
      commit(ops);
      news = newsFrom([...ops]);
    }
  }
  return { started, log, state };
}

export type CompanySummary = {
  id: CompanyId;
  role: Role;
  strategy: BotStrategy | 'llm';
  score: number;
  bankrupt_turn: number | null;
  completed: number;
  defaulted: number;
  /** Distinct companies that accepted a contract with this one at or after `lateTurn`. */
  late_counterparties: number;
};

export type Summary = { turns: number; companies: CompanySummary[] };

export function summarize(result: PlayResult, lateTurn = 15): Summary {
  const { state } = result;
  const companies = Object.values(state.companies)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c): CompanySummary => {
      const entry = state.config.population.find((p) => p.id === c.id);
      const rep = reputationOf(state, c, Number.POSITIVE_INFINITY);
      const late = new Set<CompanyId>();
      for (const k of Object.values(state.contracts)) {
        const { status } = k;
        const acceptedTurn =
          status.status === 'active' ||
          status.status === 'completed' ||
          status.status === 'defaulted'
            ? status.accepted_turn
            : null;
        if (acceptedTurn === null || acceptedTurn < lateTurn) continue;
        if (k.proposer === c.id) late.add(k.counterparty);
        if (k.counterparty === c.id) late.add(k.proposer);
      }
      return {
        id: c.id,
        role: c.roles[0],
        strategy: entry?.driver.kind === 'bot' ? entry.driver.strategy : 'llm',
        score: scoreOf(state, c),
        bankrupt_turn: c.standing.kind === 'bankrupt' ? c.standing.turn : null,
        completed: rep.completed,
        defaulted: rep.defaulted,
        late_counterparties: late.size,
      };
    });
  return { turns: state.turn, companies };
}

export type StrategyStats = {
  strategy: BotStrategy | 'llm';
  n: number;
  mean_score: number;
  survived: number;
  mean_bankrupt_turn: number | null;
};

export function byStrategy(summaries: readonly Summary[]): StrategyStats[] {
  const groups = new Map<BotStrategy | 'llm', CompanySummary[]>();
  for (const s of summaries) {
    for (const c of s.companies) groups.set(c.strategy, [...(groups.get(c.strategy) ?? []), c]);
  }
  return [...groups.entries()]
    .map(([strategy, cs]) => {
      const bankrupt = cs.filter((c) => c.bankrupt_turn !== null);
      return {
        strategy,
        n: cs.length,
        mean_score: Math.round(cs.reduce((sum, c) => sum + c.score, 0) / cs.length),
        survived: cs.length - bankrupt.length,
        mean_bankrupt_turn:
          bankrupt.length === 0
            ? null
            : Math.round(
                bankrupt.reduce((sum, c) => sum + (c.bankrupt_turn ?? 0), 0) / bankrupt.length,
              ),
      };
    })
    .sort((a, b) => b.mean_score - a.mean_score);
}

/** Two of every role, all honest, the spec's default population. */
export function roster(
  assign: (role: Role, slot: 0 | 1) => BotStrategy,
  overrides: Partial<Omit<RunConfigInput, 'population' | 'seed'>> = {},
  seed = 1,
): RunConfig {
  const roles: Role[] = ['miner', 'logger', 'smelter', 'mill', 'toolmaker', 'furniture_maker'];
  const names = [
    'Ironreach',
    'Deepcut',
    'Fellwood',
    'Saltpine',
    'Emberworks',
    'Kilnmark',
    'Birchline Mills',
    'Sawyer and Sons',
    'Anvilgate',
    'Quill Forge',
    'Hearthstead',
    'Oakhollow',
  ];
  const population = roles.flatMap((role, i) =>
    ([0, 1] as const).map((slot) => ({
      id: `c${String(i * 2 + slot + 1).padStart(2, '0')}`,
      name: names[i * 2 + slot] ?? `Company ${i * 2 + slot}`,
      role,
      driver: { kind: 'bot' as const, strategy: assign(role, slot) },
    })),
  );
  return RunConfig.parse({ experiment_id: 'bots', ...overrides, seed, population });
}
