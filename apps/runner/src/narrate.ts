import { describe, fold, scoreOf } from '@agent-economy/engine';
import type { Event, EventId, EventOf, Moment } from '@agent-economy/schema';
import { z } from 'zod';

// Notable moments. The digest is the log cut down to what a reader of the dashboard would call
// a moment; the narrator cites digest lines by event id; `check` keeps only citations that name
// a real event inside the moment's turn range. Nothing uncited reaches the dashboard.

/** Event types worth a digest line. Operations noise (extraction, upkeep, storage) stays out. */
const DIGEST_TYPES = new Set<Event['type']>([
  'contract_proposed',
  'contract_accepted',
  'contract_rejected',
  'contract_completed',
  'contract_defaulted',
  'escrow_forfeited',
  'penalty_charged',
  'transfer_made',
  'message_posted',
  'dm_sent',
  'npc_market_cleared',
  'shock_applied',
  'company_bankrupt',
  'license_bought',
  'license_auctioned',
  'company_rebranded',
  'agent_replaced_by_bot',
  'bug_report_filed',
  'run_ended',
]);

const MESSAGE_TYPES = new Set<Event['type']>(['message_posted', 'dm_sent']);

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The log as numbered lines a narrator can cite. Messages go first when the cap bites. */
export function digest(
  started: EventOf<'run_started'>,
  rest: readonly Event[],
  maxLines = 2500,
): string {
  const state = fold(started, rest);
  const { population, knobs } = started.payload.config;
  const header = [
    `Run with ${population.length} companies over ${state.turn} turns.`,
    `Knobs: enforcement ${knobs.enforcement}, reputation ${knobs.reputation_visibility}, shocks ${knobs.shocks}, needs board ${knobs.needs_board}.`,
    'Companies (id, name, role, driver, final net worth, standing):',
    ...population.map((p) => {
      const c = state.companies[p.id];
      const driver = p.driver.kind === 'llm' ? p.driver.model : `${p.driver.strategy} bot`;
      const worth = c === undefined ? '?' : String(scoreOf(state, c));
      const standing = c?.standing.kind ?? '?';
      return `  ${p.id} ${p.name}: ${p.role}, ${driver}, net worth ${worth}, ${standing}`;
    }),
    '',
    'Events, one per line as [event id] T<turn> r<round> <actor>: <what happened>.',
  ];
  let lines = rest.filter((e) => DIGEST_TYPES.has(e.type));
  if (lines.length > maxLines) lines = lines.filter((e) => !MESSAGE_TYPES.has(e.type));
  if (lines.length > maxLines) lines = lines.filter((e) => e.type !== 'contract_proposed');
  const body = lines
    .slice(0, maxLines)
    .map(
      (e) =>
        `[${e.id}] T${e.turn}${e.round === null ? '' : ` r${e.round}`} ${e.actor ?? 'engine'}: ${clip(describe(e), 240)}`,
    );
  return [...header, ...body].join('\n');
}

export function prompt(digestText: string): string {
  return [
    'You are writing the "Notable moments" panel of an admin dashboard for a simulated economy',
    'in which LLM agents run companies that mine, log, smelt, mill, make tools and furniture,',
    'trade by contract, and may default. Below is a digest of one run: a header, then one line',
    'per event with its id in brackets.',
    '',
    'Write 4 to 7 moments a researcher would want to know about: defaults and who was burned,',
    'bankruptcies, collusion or price moves, shocks and how companies reacted, reputations',
    'earned or lost, anything surprising. Order by importance. Each moment is 1 to 3 plain',
    'sentences naming companies by name with specific numbers from the digest.',
    '',
    'Every claim must be backed by event ids copied exactly from the brackets. Cite 1 to 6 ids',
    "per moment, all inside the moment's turn range. Never invent an id. If the digest shows",
    'nothing notable, return fewer moments rather than padding.',
    '',
    'Return ONLY a JSON array, no prose, no code fence:',
    '[{"from_turn": 27, "to_turn": 27, "text": "...", "events": ["<id>", "<id>"]}]',
    '',
    'DIGEST',
    digestText,
  ].join('\n');
}

const RawMoment = z.object({
  from_turn: z.number().int().nonnegative(),
  to_turn: z.number().int().nonnegative(),
  text: z.string().min(1).max(1500),
  events: z.array(z.string()).max(12),
});
export type RawMoment = z.infer<typeof RawMoment>;

/** The narrator's reply as moments, tolerating a code fence or prose around the array. */
export function parse(text: string): RawMoment[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no JSON array in the reply');
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  return z.array(RawMoment).parse(parsed);
}

/** Keep citations that name a real event inside the turn range; drop moments left with none. */
export function check(raw: readonly RawMoment[], events: readonly Event[]): Moment[] {
  const byId = new Map<string, Event>(events.map((e) => [e.id, e]));
  return raw.flatMap((m) => {
    const from = Math.min(m.from_turn, m.to_turn);
    const to = Math.max(m.from_turn, m.to_turn);
    const valid: EventId[] = [];
    for (const id of new Set(m.events)) {
      const e = byId.get(id);
      if (e !== undefined && e.turn >= from && e.turn <= to) valid.push(e.id);
    }
    if (valid.length === 0) return [];
    return [{ from_turn: from, to_turn: to, text: m.text, events: valid, cited: m.events.length }];
  });
}
