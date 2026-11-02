import {
  type AnalysisSummary,
  type CapitalRow,
  capitalRows,
  type DefaultCase,
  defaultCases,
  type ProposalCase,
  proposalCases,
  summarize,
} from '@agent-economy/engine';
import type { Event, EventOf } from '@agent-economy/schema';

// The step 3 reports over ended runs: how each default happened, whom each proposal went to and
// what the proposer could see about them, and how much each company had locked in escrow.
//   ADMIN_TOKEN=... node apps/runner/src/analyze.ts --api http://localhost:3010 --experiment m6-awake [--json out.json]

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key?.startsWith('--') && value !== undefined) args.set(key.slice(2), value);
}
const api = args.get('api') ?? 'http://localhost:3000';
const experiment = args.get('experiment');
if (experiment === undefined) throw new Error('pass --experiment <id>');
const adminToken = process.env.ADMIN_TOKEN;
if (adminToken === undefined) throw new Error('set ADMIN_TOKEN');

type Listing = { id: string; experiment_id: string; seed: number; status: string };
const admin = async <T>(route: string): Promise<T> => {
  const response = await fetch(`${api}${route}`, { headers: { 'x-admin-token': adminToken } });
  if (!response.ok) throw new Error(`GET ${route}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

type Analyzed = {
  id: string;
  variant: string;
  seed: number;
  defaults: DefaultCase[];
  proposals: ProposalCase[];
  capital: CapitalRow[];
  summary: AnalysisSummary;
};

const runs = (await admin<{ runs: Listing[] }>('/admin/runs')).runs.filter(
  (r) => r.status === 'ended' && r.experiment_id.startsWith(`${experiment}/`),
);
const analyzed: Analyzed[] = [];
for (const r of runs) {
  const metrics = await admin<{ bot_handoffs: number }>(`/admin/runs/${r.id}/metrics`);
  if (metrics.bot_handoffs > 0) {
    process.stderr.write(
      `ignoring ${r.experiment_id} seed ${r.seed}: ${metrics.bot_handoffs} bot handoffs\n`,
    );
    continue;
  }
  const { events } = await admin<{ events: Event[] }>(`/admin/runs/${r.id}/events`);
  const [started, ...rest] = events;
  if (started?.type !== 'run_started') continue;
  const defaults = defaultCases(started as EventOf<'run_started'>, rest);
  const proposals = proposalCases(started as EventOf<'run_started'>, rest);
  const capital = capitalRows(started as EventOf<'run_started'>, rest);
  analyzed.push({
    id: r.id,
    variant: r.experiment_id.slice(experiment.length + 1),
    seed: r.seed,
    defaults,
    proposals,
    capital,
    summary: summarize(defaults, proposals, capital),
  });
}

const variants = [...new Set(analyzed.map((a) => a.variant))];
const pct = (n: number, d: number) => (d === 0 ? '-' : `${((100 * n) / d).toFixed(0)}%`);
const width = Math.max(12, ...variants.map((v) => v.length)) + 2;
const row = (label: string, cells: string[]) =>
  process.stdout.write(`${label.padEnd(36)}${cells.map((c) => c.padStart(width)).join('')}\n`);
const of = (v: string) => analyzed.filter((a) => a.variant === v);
const sum = (v: string, pick: (s: AnalysisSummary) => number) =>
  of(v).reduce((acc, a) => acc + pick(a.summary), 0);

row(
  `${experiment}: ${analyzed.length} runs`,
  variants.map((v) => `${v} (n=${of(v).length})`),
);
row(
  'defaults',
  variants.map((v) => String(sum(v, (s) => s.defaults.total))),
);
for (const label of [
  'no_attempt',
  'had_means',
  'rejected_short',
  'partial',
  'late_acceptance',
  'competing_due',
  'bankruptcy',
] as const) {
  row(
    `  ${label}`,
    variants.map((v) =>
      pct(
        sum(v, (s) => s.defaults.by_label[label] ?? 0),
        sum(v, (s) => s.defaults.total),
      ),
    ),
  );
}
row(
  'proposals',
  variants.map((v) => String(sum(v, (s) => s.proposals.total))),
);
row(
  '  accepted',
  variants.map((v) =>
    pct(
      sum(v, (s) => s.proposals.accepted),
      sum(v, (s) => s.proposals.total),
    ),
  ),
);
row(
  '  to a defaulter',
  variants.map((v) =>
    pct(
      sum(v, (s) => s.proposals.to_defaulter),
      sum(v, (s) => s.proposals.total),
    ),
  ),
);
row(
  '    with a clean alternative',
  variants.map((v) =>
    pct(
      sum(v, (s) => s.proposals.to_defaulter_with_clean_alternative),
      sum(v, (s) => s.proposals.to_defaulter),
    ),
  ),
);
row(
  '  to one that burned you',
  variants.map((v) =>
    pct(
      sum(v, (s) => s.proposals.to_one_that_burned_you),
      sum(v, (s) => s.proposals.total),
    ),
  ),
);
row(
  '  repeat partner',
  variants.map((v) =>
    pct(
      sum(v, (s) => s.proposals.repeat),
      sum(v, (s) => s.proposals.total),
    ),
  ),
);
row(
  '  broadcast',
  variants.map((v) =>
    pct(
      sum(v, (s) => s.proposals.broadcast),
      sum(v, (s) => s.proposals.total),
    ),
  ),
);
row(
  '  switched after a burn',
  variants.map((v) => String(sum(v, (s) => s.proposals.switched_after_burn))),
);
const meanOf = (v: string, pick: (s: AnalysisSummary) => number | null) => {
  const xs = of(v).flatMap((a) => (pick(a.summary) === null ? [] : [pick(a.summary) as number]));
  return xs.length === 0 ? '-' : (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2);
};
row(
  '  price/ref to clean',
  variants.map((v) => meanOf(v, (s) => s.proposals.mean_price_ratio_clean)),
);
row(
  '  price/ref to defaulter',
  variants.map((v) => meanOf(v, (s) => s.proposals.mean_price_ratio_defaulter)),
);
row(
  'company-turns squeezed',
  variants.map((v) =>
    pct(
      sum(v, (s) => s.capital.squeezed_turns),
      sum(v, (s) => s.capital.company_turns),
    ),
  ),
);
row(
  'mean escrow share of worth',
  variants.map((v) => meanOf(v, (s) => s.capital.mean_escrow_share)),
);

const out = args.get('json');
if (out !== undefined) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, JSON.stringify(analyzed, null, 2));
  process.stdout.write(`wrote ${out}\n`);
}
