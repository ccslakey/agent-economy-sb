import type {
  CompanyId,
  Event,
  EventId,
  EventOf,
  FinalGood,
  RunState,
} from '@agent-economy/schema';
import { apply, initialState } from './fold.ts';
import { reputationOf, scoreOf } from './world.ts';

// Notable moments, detected from the log by rule: default waves, the worst defaulter and the
// record it had before, bankruptcies, shocks with the price reaction, the biggest price swing,
// lead changes, stalled trade, bot handoffs, license auctions, and how the run ended. Every
// moment cites the event ids it was built from, so a reader can check each claim.

export type MomentKind =
  | 'default_wave'
  | 'worst_defaulter'
  | 'bankruptcy'
  | 'shock'
  | 'price_swing'
  | 'lead_change'
  | 'trade_stalled'
  | 'bot_handoff'
  | 'license'
  | 'run_end';

export type Moment = {
  kind: MomentKind;
  from_turn: number;
  to_turn: number;
  text: string;
  events: EventId[];
  /** Higher ranks first. Roughly the cash at stake, with structural events weighted up. */
  weight: number;
};

const MAX_CITES = 6;
const fmt = (n: number): string => n.toLocaleString('en-US');
const span = (from: number, to: number): string =>
  from === to ? `T${from}` : `T${from} to T${to}`;
const list = (xs: string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
const cap = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const plural = (n: number, one: string, many = `${one}s`): string =>
  `${fmt(n)} ${n === 1 ? one : many}`;

type TurnClose = { turn: number; state: RunState; event: Event };

type Context = {
  rest: readonly Event[];
  final: RunState;
  closes: TurnClose[];
  name: (id: CompanyId) => string;
};

function defaultWaves({ rest, final, name }: Context): Moment[] {
  const defaults = rest.filter(
    (e): e is EventOf<'contract_defaulted'> => e.type === 'contract_defaulted',
  );
  const clusters: EventOf<'contract_defaulted'>[][] = [];
  for (const e of defaults) {
    const last = clusters.at(-1);
    const prev = last?.at(-1);
    if (last !== undefined && prev !== undefined && e.turn - prev.turn <= 1) last.push(e);
    else clusters.push([e]);
  }
  return clusters
    .filter((c) => c.length >= 2)
    .map((c) => {
      const value = c.reduce((sum, e) => sum + e.payload.unmet_value, 0);
      const byCompany = new Map<CompanyId, { count: number; value: number }>();
      for (const e of c) {
        const k = final.contracts[e.payload.contract];
        if (k === undefined) continue;
        for (const party of e.payload.by) {
          const id = party === 'proposer' ? k.proposer : k.counterparty;
          const t = byCompany.get(id) ?? { count: 0, value: 0 };
          t.count += 1;
          t.value += e.payload.unmet_value;
          byCompany.set(id, t);
        }
      }
      const worst = [...byCompany.entries()].sort(([, a], [, b]) => b.value - a.value).slice(0, 3);
      const from = c[0]?.turn ?? 0;
      const to = c.at(-1)?.turn ?? from;
      return {
        kind: 'default_wave' as const,
        from_turn: from,
        to_turn: to,
        text: `${plural(c.length, 'contract')} defaulted in ${span(from, to)}, ${fmt(value)} left unmet. ${list(
          worst.map(
            ([id, t]) => `${name(id)} failed ${plural(t.count, 'contract')} worth ${fmt(t.value)}`,
          ),
        )}.`,
        events: c.slice(0, MAX_CITES).map((e) => e.id),
        weight: value + 100 * c.length,
      };
    });
}

function worstDefaulter({ rest, final, name }: Context): Moment[] {
  const ranked = Object.values(final.companies)
    .map((c) => ({ c, rep: reputationOf(final, c) }))
    .filter((x) => x.rep.value_defaulted > 0)
    .sort((a, b) => b.rep.value_defaulted - a.rep.value_defaulted);
  const top = ranked[0];
  if (top === undefined) return [];
  const mine = rest.filter((e): e is EventOf<'contract_defaulted'> => {
    if (e.type !== 'contract_defaulted') return false;
    const k = final.contracts[e.payload.contract];
    if (k === undefined) return false;
    return e.payload.by.some((p) => (p === 'proposer' ? k.proposer : k.counterparty) === top.c.id);
  });
  const first = mine[0];
  if (first === undefined) return [];
  const before = reputationOf(final, top.c, first.turn - 1).completed;
  const record =
    before >= 3
      ? ` It had settled ${plural(before, 'contract')} on time before its first default at T${first.turn}.`
      : before === 0
        ? ` It never completed a contract before its first default at T${first.turn}.`
        : '';
  return [
    {
      kind: 'worst_defaulter',
      from_turn: first.turn,
      to_turn: mine.at(-1)?.turn ?? first.turn,
      text: `${name(top.c.id)} defaulted on ${plural(top.rep.defaulted, 'contract')} worth ${fmt(top.rep.value_defaulted)}, the most of any company.${record}`,
      events: mine.slice(0, MAX_CITES).map((e) => e.id),
      weight: top.rep.value_defaulted + 500,
    },
  ];
}

function bankruptcies({ rest, name }: Context): Moment[] {
  const events = rest.filter(
    (e): e is EventOf<'company_bankrupt'> => e.type === 'company_bankrupt',
  );
  const byTurn = new Map<number, EventOf<'company_bankrupt'>[]>();
  for (const e of events) byTurn.set(e.turn, [...(byTurn.get(e.turn) ?? []), e]);
  return [...byTurn.entries()].map(([turn, group]) => {
    const voided = group.reduce((sum, e) => sum + e.payload.contracts_defaulted.length, 0);
    const who = group.map((e) => {
      const actor = e.actor;
      return actor === null ? 'a company' : `${name(actor)} (${fmt(e.payload.cash)} cash)`;
    });
    return {
      kind: 'bankruptcy' as const,
      from_turn: turn,
      to_turn: turn,
      text: `${list(who)} went bankrupt at T${turn}${voided > 0 ? `, voiding ${plural(voided, 'open contract')}` : ''}.`,
      events: group.slice(0, MAX_CITES).map((e) => e.id),
      weight: 1500 * group.length + 100 * voided,
    };
  });
}

const clearsOf = (rest: readonly Event[], good: FinalGood) =>
  rest.filter(
    (e): e is EventOf<'npc_market_cleared'> =>
      e.type === 'npc_market_cleared' && e.payload.good === good,
  );

function shocks({ rest }: Context): Moment[] {
  return rest
    .filter((e): e is EventOf<'shock_applied'> => e.type === 'shock_applied')
    .map((e) => {
      const { shock } = e.payload;
      const until = e.payload.until_turn;
      const cites: EventId[] = [e.id];
      let reaction = '';
      let from = e.turn;
      if (shock.kind === 'demand_surge' || shock.kind === 'demand_slump') {
        const clears = clearsOf(rest, shock.good);
        const before = clears.findLast((c) => c.turn < e.turn);
        const during = clears.find((c) => c.turn >= e.turn && c.turn <= until);
        if (before !== undefined && during !== undefined) {
          reaction = ` ${cap(shock.good)} had cleared at ${fmt(before.payload.price)} in T${before.turn} and cleared at ${fmt(during.payload.price)} in T${during.turn}.`;
          cites.push(before.id, during.id);
          from = before.turn;
        } else if (during === undefined) {
          reaction = ` No ${shock.good} cleared while it lasted.`;
        }
      }
      const label =
        shock.kind === 'grove_fire'
          ? `A fire burned grove ${shock.grove}`
          : shock.kind === 'miners_strike'
            ? "A miners' strike cut ore extraction"
            : `A ${shock.kind === 'demand_surge' ? 'demand surge' : 'demand slump'} hit ${shock.good}`;
      const lasted = until > e.turn ? `, lasting to T${until}` : '';
      return {
        kind: 'shock' as const,
        from_turn: from,
        to_turn: Math.max(e.turn, until),
        text: `${label} at T${e.turn}${lasted}.${reaction}`,
        events: cites,
        // Demand shocks move prices and so trades; a fire or a strike is background unless it is all there is.
        weight: shock.kind === 'demand_surge' || shock.kind === 'demand_slump' ? 450 : 250,
      };
    });
}

function priceSwing({ rest, final }: Context): Moment[] {
  const goods = new Set(
    rest.flatMap((e) => (e.type === 'npc_market_cleared' ? [e.payload.good] : [])),
  );
  let best: Moment | null = null;
  for (const good of goods) {
    const clears = clearsOf(rest, good);
    for (let i = 1; i < clears.length; i += 1) {
      const a = clears[i - 1];
      const b = clears[i];
      if (a === undefined || b === undefined || a.payload.price === 0) continue;
      const move = (b.payload.price - a.payload.price) / a.payload.price;
      if (Math.abs(move) < 0.2) continue;
      const reference = final.config.economy.reference_prices[good];
      const weight = Math.abs(move) * 1000;
      if (best !== null && weight <= best.weight) continue;
      best = {
        kind: 'price_swing',
        from_turn: a.turn,
        to_turn: b.turn,
        text: `The ${good} price ${move > 0 ? 'rose' : 'fell'} ${Math.round(Math.abs(move) * 100)}%, from ${fmt(a.payload.price)} in T${a.turn} to ${fmt(b.payload.price)} in T${b.turn}, against a reference of ${fmt(reference)}.`,
        events: [a.id, b.id],
        weight,
      };
    }
  }
  return best === null ? [] : [best];
}

function leadChanges({ closes, name }: Context): Moment[] {
  const leaderAt = (s: RunState): CompanyId | null => {
    let best: { id: CompanyId; score: number } | null = null;
    for (const c of Object.values(s.companies)) {
      const score = scoreOf(s, c);
      if (best === null || score > best.score) best = { id: c.id, score };
    }
    return best?.id ?? null;
  };
  const leaders = closes.map((c) => ({ ...c, leader: leaderAt(c.state) }));
  let lastChange: { index: number; from: CompanyId | null; to: CompanyId } | null = null;
  let changes = 0;
  for (let i = 1; i < leaders.length; i += 1) {
    const prev = leaders[i - 1];
    const cur = leaders[i];
    if (prev === undefined || cur === undefined || cur.leader === null) continue;
    if (cur.leader !== prev.leader) {
      changes += 1;
      lastChange = { index: i, from: prev.leader, to: cur.leader };
    }
  }
  if (lastChange === null) return [];
  const at = leaders[lastChange.index];
  const end = leaders.at(-1);
  if (at === undefined || end === undefined) return [];
  const held = end.turn - at.turn;
  return [
    {
      kind: 'lead_change',
      from_turn: at.turn,
      to_turn: end.turn,
      text: `${name(lastChange.to)} took the lead at T${at.turn}${lastChange.from === null ? '' : ` from ${name(lastChange.from)}`} and held it for the remaining ${plural(held, 'turn')}. The lead changed hands ${plural(changes, 'time')} in all.`,
      events: [at.event.id],
      weight: 400 + 20 * held,
    },
  ];
}

function tradeStalled({ rest, closes }: Context): Moment[] {
  const acceptedByTurn = new Map<number, number>();
  for (const e of rest) {
    if (e.type === 'contract_accepted')
      acceptedByTurn.set(e.turn, (acceptedByTurn.get(e.turn) ?? 0) + 1);
  }
  const total = [...acceptedByTurn.values()].reduce((s, n) => s + n, 0);
  let quiet: TurnClose[] = [];
  for (let i = closes.length - 1; i >= 0; i -= 1) {
    const c = closes[i];
    if (c === undefined || (acceptedByTurn.get(c.turn) ?? 0) > 0) break;
    quiet.unshift(c);
  }
  // The final turn is not counted: a game that closes mid-trade would otherwise always qualify.
  quiet = quiet.filter((c) => c.event.type === 'turn_closed');
  if (quiet.length < 3 || total === 0) return [];
  const first = quiet[0];
  const last = quiet.at(-1);
  if (first === undefined || last === undefined) return [];
  return [
    {
      kind: 'trade_stalled',
      from_turn: first.turn,
      to_turn: last.turn,
      text: `No contract was accepted from T${first.turn} on, ${plural(quiet.length, 'turn')} of silence after ${plural(total, 'acceptance')} earlier in the run.`,
      events: quiet.slice(0, MAX_CITES).map((c) => c.event.id),
      weight: 300 + 50 * quiet.length,
    },
  ];
}

function botHandoffs({ rest, name }: Context): Moment[] {
  return rest
    .filter((e): e is EventOf<'agent_replaced_by_bot'> => e.type === 'agent_replaced_by_bot')
    .map((e) => ({
      kind: 'bot_handoff' as const,
      from_turn: e.turn,
      to_turn: e.turn,
      text: `${e.actor === null ? 'A company' : name(e.actor)} was handed to a ${e.payload.strategy.replaceAll('_', ' ')} bot at T${e.turn}: ${e.payload.reason}.`,
      events: [e.id],
      weight: 1200,
    }));
}

function licenses({ rest, name }: Context): Moment[] {
  return rest
    .filter((e): e is EventOf<'license_auctioned'> => e.type === 'license_auctioned')
    .map((e) => ({
      kind: 'license' as const,
      from_turn: e.turn,
      to_turn: e.turn,
      text:
        e.payload.result.kind === 'sold'
          ? `${name(e.payload.result.winner)} bought the ${e.payload.role.replaceAll('_', ' ')} license at auction for ${fmt(e.payload.result.bid)} at T${e.turn}.`
          : `The ${e.payload.role.replaceAll('_', ' ')} license went unsold at auction at T${e.turn}; nobody bid.`,
      events: [e.id],
      weight: e.payload.result.kind === 'sold' ? 200 + e.payload.result.bid : 250,
    }));
}

const ENDINGS = {
  horizon_roll: 'The horizon roll ended the run',
  fixed_last_turn: 'The run reached its fixed last turn',
  aborted: 'The run was aborted',
} as const;

function runEnd({ rest, final, name }: Context): Moment[] {
  const e = rest.findLast((x): x is EventOf<'run_ended'> => x.type === 'run_ended');
  if (e === undefined) return [];
  const ranked = Object.values(final.companies)
    .map((c) => ({ id: c.id, score: scoreOf(final, c) }))
    .sort((a, b) => b.score - a.score);
  const first = ranked[0];
  const last = ranked.at(-1);
  const bankrupt = Object.values(final.companies).filter(
    (c) => c.standing.kind === 'bankrupt',
  ).length;
  if (first === undefined || last === undefined) return [];
  return [
    {
      kind: 'run_end',
      from_turn: e.turn,
      to_turn: e.turn,
      text: `${ENDINGS[e.payload.reason]} at T${e.turn}. ${name(first.id)} finished first with ${fmt(first.score)} and ${name(last.id)} last with ${fmt(last.score)}${bankrupt > 0 ? `; ${plural(bankrupt, 'company', 'companies')} ended bankrupt` : ''}.`,
      events: [e.id],
      weight: 450,
    },
  ];
}

const DETECTORS = [
  defaultWaves,
  worstDefaulter,
  bankruptcies,
  shocks,
  priceSwing,
  leadChanges,
  tradeStalled,
  botHandoffs,
  licenses,
  runEnd,
];

/** The run's notable moments, most important first, at most `limit` of them. */
export function moments(
  started: EventOf<'run_started'>,
  rest: readonly Event[],
  limit = 8,
): Moment[] {
  let state = initialState(started);
  const closes: TurnClose[] = [];
  for (const e of rest) {
    state = apply(state, e);
    if (e.type === 'turn_closed' || e.type === 'run_ended')
      closes.push({ turn: e.turn, state, event: e });
  }
  const final = state;
  const context: Context = {
    rest,
    final,
    closes,
    name: (id) => final.companies[id]?.name ?? id,
  };
  return DETECTORS.flatMap((detect) => detect(context))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}
