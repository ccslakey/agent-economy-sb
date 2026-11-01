import { type BotStrategy, type Role, RunConfig } from '@agent-economy/schema';
import { byStrategy, playBots, roster, summarize } from './play.ts';

// The tuning loop's instrument. Plays a roster over many seeds and prints what the M3 criteria
// look at: survival, bankruptcy turn, score, and contract outcomes per strategy and per role.
//
//   node apps/runner/src/tune.ts [--seeds 20] [--roster mixed|honest] [--turns 40] [--economy '{"upkeep":50}']

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key?.startsWith('--') && value !== undefined) args.set(key.slice(2), value);
}
const seeds = Number(args.get('seeds') ?? 20);
const turns = Number(args.get('turns') ?? 40);
const economy = JSON.parse(args.get('economy') ?? '{}') as Record<string, unknown>;
const knobs = JSON.parse(args.get('knobs') ?? '{}') as Record<string, unknown>;
const which = args.get('roster') ?? 'mixed';

const assign = (role: Role, slot: 0 | 1): BotStrategy => {
  if (which === 'honest') return 'honest_trader';
  if (role === 'smelter' && slot === 1) return 'defector';
  if (role === 'miner' && slot === 1) return 'greedy_producer';
  if (role === 'mill' && slot === 1) return 'passive';
  if (role === 'logger' && slot === 1) return 'random';
  return 'honest_trader';
};

const summaries = [];
for (let seed = 1; seed <= seeds; seed++) {
  const base = roster(assign, {}, seed);
  const config = RunConfig.parse({
    ...base,
    economy: { ...base.economy, ...economy },
    knobs: { ...base.knobs, horizon: { kind: 'fixed', last_turn: turns }, ...knobs },
  });
  summaries.push(summarize(playBots(config)));
}

const stats = byStrategy(summaries);
const lines = [
  `seeds=${seeds} turns=${turns} roster=${which} economy=${JSON.stringify(economy)} knobs=${JSON.stringify(knobs)}`,
  '',
  'strategy          n   mean_score  survived  mean_bankrupt_turn',
  ...stats.map(
    (s) =>
      `${s.strategy.padEnd(16)} ${String(s.n).padStart(3)}  ${String(s.mean_score).padStart(10)}  ${String(s.survived).padStart(8)}  ${String(s.mean_bankrupt_turn ?? '-').padStart(18)}`,
  ),
  '',
  'role              strategy          mean_score  bankrupt  completed  defaulted  late_cps',
];
const byRole = new Map<string, (typeof summaries)[number]['companies']>();
for (const s of summaries) {
  for (const c of s.companies) {
    const key = `${c.role}|${c.strategy}`;
    byRole.set(key, [...(byRole.get(key) ?? []), c]);
  }
}
for (const [key, cs] of [...byRole.entries()].sort()) {
  const [role, strategy] = key.split('|');
  const mean = (f: (c: (typeof cs)[number]) => number) =>
    (cs.reduce((sum, c) => sum + f(c), 0) / cs.length).toFixed(1);
  lines.push(
    `${(role ?? '').padEnd(16)}  ${(strategy ?? '').padEnd(16)} ${mean((c) => c.score).padStart(10)}  ${String(cs.filter((c) => c.bankrupt_turn !== null).length).padStart(8)}  ${mean((c) => c.completed).padStart(9)}  ${mean((c) => c.defaulted).padStart(9)}  ${mean((c) => c.late_counterparties).padStart(8)}`,
  );
}
const detail = args.get('detail');
if (detail !== undefined) {
  const s = summaries[Number(detail) - 1];
  if (s !== undefined) {
    lines.push('', `seed ${detail}: turns=${s.turns}`);
    for (const c of s.companies) {
      lines.push(
        `  ${c.id} ${c.role.padEnd(16)} ${c.strategy.padEnd(16)} score=${String(c.score).padStart(6)} bankrupt=${String(c.bankrupt_turn ?? '-').padStart(3)} completed=${c.completed} defaulted=${c.defaulted} cured=${c.cured} late_cps=${c.late_counterparties}`,
      );
    }
  }
}
process.stdout.write(`${lines.join('\n')}\n`);
