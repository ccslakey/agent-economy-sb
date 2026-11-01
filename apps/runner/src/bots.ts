import type { Rng } from '@agent-economy/engine';
import {
  type Action,
  type BotStrategy,
  type CompanyId,
  type Contract,
  FINAL_GOODS,
  GOODS,
  type Good,
  type Observation,
  type Party,
  producerOf,
  ROLES,
  recipeOf,
} from '@agent-economy/schema';

// Scripted baseline bots. Each is a pure decision function over what an agent could see through
// the API: its observation plus its own contracts. Memory is a small object the bot owns, the
// in-process stand-in for the notes file.

export type BotView = {
  observation: Observation;
  contracts: readonly Contract[];
  /** Reference prices from the run config, which agents read from the docs. */
  prices: Record<Good, number>;
};

export type BotMemory = {
  /** Goods promised on contracts accepted this turn, so one unit is never sold twice. */
  reserved: Partial<Record<Good, number>>;
  /** Companies that defaulted on a contract with this bot. Used when reputation is hidden. */
  burned: CompanyId[];
  /** Proposals of ours each company let expire or rejected. Two strikes and we stop asking. */
  ignored: Partial<Record<CompanyId, number>>;
  /** Contract ids already counted toward `ignored`. */
  counted: string[];
};

export const freshMemory = (): BotMemory => ({
  reserved: {},
  burned: [],
  ignored: {},
  counted: [],
});

/** Keep two turns of output on hand; scrap the rest so storage never eats the margin. */
const BUFFER_TURNS = 2;

export type Bot = (view: BotView, memory: BotMemory, rng: Rng) => Action[];

const FINALS: ReadonlySet<Good> = new Set(FINAL_GOODS);

const sideOf = (contract: Contract, me: CompanyId): Party | null =>
  contract.proposer === me ? 'proposer' : contract.counterparty === me ? 'counterparty' : null;

const otherOf = (contract: Contract, me: CompanyId): CompanyId =>
  contract.proposer === me ? contract.counterparty : contract.proposer;

/** Companies this bot will not deal with: visibly in default, or remembered as having burned us. */
function untrusted(view: BotView, memory: BotMemory): Set<CompanyId> {
  const me = view.observation.you.id;
  const out = new Set<CompanyId>(memory.burned);
  const ledger = view.observation.reputation;
  if (ledger !== null) {
    for (const company of view.observation.companies) {
      const rep = ledger[company.id];
      if (rep !== undefined && rep.defaulted > 0) out.add(company.id);
    }
  }
  for (const k of view.contracts) {
    const side = sideOf(k, me);
    if (side === null) continue;
    const them: Party = side === 'proposer' ? 'counterparty' : 'proposer';
    if (k.status.status === 'defaulted' && k.status.by.includes(them)) out.add(otherOf(k, me));
  }
  return out;
}

/** Operations orders at capacity for every role held. Extraction picks the fullest grove. */
function ordersAtCapacity(view: BotView): Action[] {
  const { you, groves } = view.observation;
  const actions: Action[] = [];
  for (const role of you.roles) {
    const spec = ROLES[role];
    const capacity = you.capacity[spec.output] ?? 0;
    if (capacity === 0) continue;
    if (spec.verb === 'extract') {
      if (spec.source === 'ore_pit') {
        actions.push({ type: 'extract', from: { kind: 'ore_pit' }, qty: capacity });
      } else {
        const grove = [...groves].sort((a, b) => b.stock - a.stock)[0];
        if (grove !== undefined && grove.stock > 0) {
          actions.push({
            type: 'extract',
            from: { kind: 'grove', grove: grove.id },
            qty: Math.min(capacity, grove.stock),
          });
        }
      }
    } else {
      actions.push({ type: 'produce', good: spec.output, qty: capacity });
    }
  }
  return actions;
}

/** Sell every final good held to the NPC market. Contract deliveries resolve first, so this sells only what is left. */
function sellFinals(view: BotView): Action[] {
  const { inventory } = view.observation.you;
  return FINAL_GOODS.flatMap((good) => {
    const held = inventory[good] ?? 0;
    return held > 0 ? [{ type: 'sell_npc' as const, good, qty: held }] : [];
  });
}

/** Note which counterparties let our proposals expire unanswered, so demand routes to companies that answer. A rejection is an answer. */
function rememberIgnored(view: BotView, memory: BotMemory): void {
  const me = view.observation.you.id;
  for (const k of view.contracts) {
    if (k.proposer !== me || memory.counted.includes(k.id)) continue;
    if (k.status.status !== 'expired') continue;
    memory.counted.push(k.id);
    memory.ignored[k.counterparty] = (memory.ignored[k.counterparty] ?? 0) + 1;
  }
}

/** Propose pay-on-delivery purchases of every input a produce role needs for a full turn, split across the suppliers that answer. */
function proposeInputs(view: BotView, memory: BotMemory): Action[] {
  const { you, companies, turn } = view.observation;
  const avoid = untrusted(view, memory);
  const actions: Action[] = [];
  let cash = you.cash;
  for (const role of you.roles) {
    const spec = ROLES[role];
    if (spec.verb !== 'produce') continue;
    const capacity = you.capacity[spec.output] ?? 0;
    const recipe = recipeOf(spec.output);
    for (const input of GOODS) {
      const perUnit = recipe[input];
      if (perUnit === undefined) continue;
      const need = capacity * perUnit - (you.inventory[input] ?? 0);
      if (need <= 0) continue;
      const candidates = companies.filter(
        (c) => c.id !== you.id && c.roles.includes(producerOf(input)) && !avoid.has(c.id),
      );
      const responsive = candidates.filter((c) => (memory.ignored[c.id] ?? 0) < 2);
      const suppliers = responsive.length > 0 ? responsive : candidates;
      if (suppliers.length === 0) continue;
      const share = Math.ceil(need / suppliers.length);
      let remaining = need;
      for (const supplier of suppliers) {
        const qty = Math.min(share, remaining, Math.floor(cash / view.prices[input]));
        if (qty <= 0) break;
        remaining -= qty;
        cash -= qty * view.prices[input];
        actions.push({
          type: 'propose_contract',
          counterparty: supplier.id,
          terms_text: `${qty} ${input} this turn for ${qty * view.prices[input]} cash next turn`,
          obligations: [
            { kind: 'goods', by: 'counterparty', good: input, qty, due_turn: turn },
            { kind: 'cash', by: 'proposer', amount: qty * view.prices[input], due_turn: turn + 1 },
          ],
        });
      }
    }
  }
  return actions;
}

/** Scrap intermediate stock above the buffer, after what this round's deliveries will take. */
function scrapSurplus(view: BotView, planned: readonly Action[]): Action[] {
  const { you } = view.observation;
  const outgoing: Partial<Record<Good, number>> = {};
  for (const a of planned) {
    if (a.type !== 'deliver') continue;
    const k = view.contracts.find((c) => c.id === a.contract);
    const o = k?.obligations[a.obligation];
    if (o?.kind === 'goods') outgoing[o.good] = (outgoing[o.good] ?? 0) + a.qty;
  }
  const actions: Action[] = [];
  for (const role of you.roles) {
    const good = ROLES[role].output;
    if (FINALS.has(good)) continue;
    const keep = BUFFER_TURNS * (you.capacity[good] ?? 0);
    const surplus = (you.inventory[good] ?? 0) - (outgoing[good] ?? 0) - keep;
    if (surplus > 0) actions.push({ type: 'scrap', good, qty: surplus });
  }
  return actions;
}

/** Accept proposals we can cover at a fair price from companies we trust; reject the rest. */
function answerProposals(view: BotView, memory: BotMemory): Action[] {
  const me = view.observation.you.id;
  const avoid = untrusted(view, memory);
  const actions: Action[] = [];
  const sorted = view.contracts
    .filter((k) => k.status.status === 'proposed' && k.counterparty === me)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  // Rotate who gets first pick each turn, so scarce stock is not always sold to the lowest id.
  const offset = sorted.length === 0 ? 0 : view.observation.turn % sorted.length;
  const proposed = [...sorted.slice(offset), ...sorted.slice(0, offset)];
  for (const k of proposed) {
    const owed = k.obligations.filter((o) => o.by === 'counterparty');
    const paid = k.obligations
      .filter((o) => o.by === 'proposer' && o.kind === 'cash')
      .reduce((sum, o) => sum + (o.kind === 'cash' ? o.amount : 0), 0);
    const value = owed.reduce(
      (sum, o) => sum + (o.kind === 'goods' ? o.qty * view.prices[o.good] : o.amount),
      0,
    );
    const coverable = owed.every((o) => {
      if (o.kind !== 'goods') return false;
      const held = view.observation.you.inventory[o.good] ?? 0;
      return held - (memory.reserved[o.good] ?? 0) >= o.qty;
    });
    if (coverable && paid >= value * 0.9 && !avoid.has(k.proposer) && owed.length > 0) {
      for (const o of owed) {
        if (o.kind === 'goods') memory.reserved[o.good] = (memory.reserved[o.good] ?? 0) + o.qty;
      }
      actions.push({ type: 'accept_contract', contract: k.id });
    } else {
      actions.push({ type: 'reject_contract', contract: k.id });
    }
  }
  return actions;
}

/** Deposit everything we owe that we can cover. Deposits are held and refunded if the other side fails. */
function fulfil(view: BotView): Action[] {
  const me = view.observation.you.id;
  const actions: Action[] = [];
  let cash = view.observation.you.cash;
  const inventory = { ...view.observation.you.inventory };
  const open = view.contracts
    .filter((k) => k.status.status === 'active')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const k of open) {
    const side = sideOf(k, me);
    k.obligations.forEach((o, index) => {
      if (o.by !== side) return;
      if (o.kind === 'goods') {
        const remaining = o.qty - o.met;
        const held = inventory[o.good] ?? 0;
        const qty = Math.min(remaining, held);
        if (qty <= 0) return;
        inventory[o.good] = held - qty;
        actions.push({ type: 'deliver', contract: k.id, obligation: index, qty });
      } else {
        const remaining = o.amount - o.met;
        if (remaining <= 0 || cash < remaining) return;
        cash -= remaining;
        actions.push({ type: 'pay', contract: k.id, obligation: index, amount: remaining });
      }
    });
  }
  return actions;
}

/** Remember who defaulted on us. Called every round so hidden reputation still informs the bot. */
function rememberBurns(view: BotView, memory: BotMemory): void {
  const me = view.observation.you.id;
  for (const k of view.contracts) {
    const side = sideOf(k, me);
    if (side === null || k.status.status !== 'defaulted') continue;
    const them: Party = side === 'proposer' ? 'counterparty' : 'proposer';
    const other = otherOf(k, me);
    if (k.status.by.includes(them) && !memory.burned.includes(other)) memory.burned.push(other);
  }
}

const honestTrader: Bot = (view, memory) => {
  const { round } = view.observation;
  rememberBurns(view, memory);
  rememberIgnored(view, memory);
  if (round === 1) {
    memory.reserved = {};
    return [...ordersAtCapacity(view), ...proposeInputs(view, memory)];
  }
  if (round === 2) return answerProposals(view, memory);
  const deliveries = fulfil(view);
  return [...deliveries, ...sellFinals(view), ...scrapSurplus(view, deliveries)];
};

/** Trades like an honest trader and never delivers or pays. */
const defector: Bot = (view, memory) => {
  const { round } = view.observation;
  rememberIgnored(view, memory);
  if (round === 1) {
    memory.reserved = {};
    return [...ordersAtCapacity(view), ...proposeInputs(view, memory)];
  }
  if (round === 2) return answerProposals(view, memory);
  return [...sellFinals(view), ...scrapSurplus(view, [])];
};

/** No contracts at all. Produces at capacity, sells finals to the NPC, scraps everything else. */
const greedyProducer: Bot = (view) => {
  const { round, you } = view.observation;
  if (round === 1) return ordersAtCapacity(view);
  if (round === 2) {
    return view.contracts
      .filter((k) => k.status.status === 'proposed' && k.counterparty === you.id)
      .map((k) => ({ type: 'reject_contract' as const, contract: k.id }));
  }
  const scrap = GOODS.flatMap((good) => {
    const qty = you.inventory[good] ?? 0;
    return qty > 0 && !FINALS.has(good) ? [{ type: 'scrap' as const, good, qty }] : [];
  });
  return [...sellFinals(view), ...scrap];
};

const randomBot: Bot = (view, _memory, rng) => {
  const { round, you, companies } = view.observation;
  const actions: Action[] = [];
  if (rng('orders') < 0.7) actions.push(...ordersAtCapacity(view));
  const others = companies.filter((c) => c.id !== you.id);
  const other = others[Math.floor(rng('other') * others.length)];
  if (other !== undefined && rng('talk') < 0.3) {
    actions.push({
      type: 'post_message',
      text: `turn ${view.observation.turn}: ${you.name} says hello`,
    });
  }
  if (other !== undefined && round === 1 && rng('propose') < 0.4) {
    const good =
      (['ore', 'timber', 'ingot', 'plank', 'tool'] as const)[Math.floor(rng('good') * 5)] ?? 'ore';
    const qty = 1 + Math.floor(rng('qty') * 6);
    actions.push({
      type: 'propose_contract',
      counterparty: other.id,
      terms_text: 'random offer',
      obligations: [
        { kind: 'goods', by: 'counterparty', good, qty, due_turn: view.observation.turn },
        {
          kind: 'cash',
          by: 'proposer',
          amount: Math.max(1, Math.floor(qty * view.prices[good] * (0.5 + rng('price')))),
          due_turn: view.observation.turn,
        },
      ],
    });
  }
  for (const k of view.contracts) {
    if (k.status.status === 'proposed' && k.counterparty === you.id) {
      actions.push({
        type: rng(`answer:${k.id}`) < 0.5 ? 'accept_contract' : 'reject_contract',
        contract: k.id,
      });
    }
  }
  if (rng('fulfil') < 0.6) actions.push(...fulfil(view));
  if (round === 3) actions.push(...sellFinals(view));
  return actions;
};

const passive: Bot = () => [];

export const BOTS: Record<BotStrategy, Bot> = {
  honest_trader: honestTrader,
  defector,
  greedy_producer: greedyProducer,
  random: randomBot,
  passive,
};
