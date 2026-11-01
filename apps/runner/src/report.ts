import { z } from 'zod';

// Renders the API's end-of-run report for a terminal. Everything an agent said about the game
// ends up here: its last plan and thoughts, its bug reports, and its farming answer.

const Report = z.object({
  run_id: z.string(),
  experiment_id: z.string(),
  turn: z.number(),
  companies: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      roles: z.array(z.string()),
      score: z.number(),
      standing: z.object({ kind: z.string() }),
      reputation: z.object({ completed: z.number(), defaulted: z.number() }),
      plan: z
        .object({
          early: z.string(),
          mid: z.string(),
          late: z.string(),
          now: z.string(),
          thoughts: z.string(),
        })
        .nullable(),
      plan_revisions: z.number(),
      notes: z.string(),
      bug_reports: z.array(
        z.object({ turn: z.number(), round: z.number().nullable(), text: z.string() }),
      ),
      farming: z.string().nullable(),
      sessions: z.number(),
    }),
  ),
});

const trim = (text: string, max = 700): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

export function formatReport(raw: unknown): string {
  const parsed = Report.safeParse(raw);
  if (!parsed.success) return `report unavailable: ${z.prettifyError(parsed.error)}`;
  const report = parsed.data;
  const lines: string[] = [
    `== Run ${report.run_id} (${report.experiment_id}), ${report.turn} turns ==`,
    '',
  ];
  lines.push('Scores');
  for (const c of [...report.companies].sort((a, b) => b.score - a.score)) {
    lines.push(
      `  ${c.id} ${c.name.padEnd(16)} ${c.roles.join(',').padEnd(16)} ${String(c.score).padStart(6)}  ${c.standing.kind}  completed ${c.reputation.completed} defaulted ${c.reputation.defaulted}  sessions ${c.sessions}`,
    );
  }
  const bugs = report.companies.flatMap((c) => c.bug_reports.map((b) => ({ ...b, company: c.id })));
  lines.push('', `Bug reports (${bugs.length})`);
  for (const b of bugs)
    lines.push(`  ${b.company} t${b.turn}${b.round === null ? '' : ` r${b.round}`}: ${b.text}`);
  for (const c of report.companies) {
    if (c.plan === null && c.farming === null) continue;
    lines.push('', `-- ${c.id} ${c.name} --`);
    if (c.plan !== null) {
      lines.push(`  plan (${c.plan_revisions} revisions)`);
      lines.push(`    early: ${trim(c.plan.early, 300)}`);
      lines.push(`    mid: ${trim(c.plan.mid, 300)}`);
      lines.push(`    late: ${trim(c.plan.late, 300)}`);
      lines.push(`    now: ${trim(c.plan.now, 300)}`);
      lines.push(`    thoughts: ${trim(c.plan.thoughts, 400)}`);
    }
    if (c.notes !== '') lines.push(`  notes: ${trim(c.notes, 400)}`);
    if (c.farming !== null) lines.push(`  farming: ${trim(c.farming)}`);
  }
  return lines.join('\n');
}
