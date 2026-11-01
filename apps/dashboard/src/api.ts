import { Event, type Knobs, type RunState } from '@agent-economy/schema';

// Admin calls. The token lives in localStorage so a reload keeps it; nothing else is stored.

export type RunListing = {
  id: string;
  experiment_id: string;
  seed: number;
  status: string;
  turn: number | null;
  phase: RunState['phase'] | null;
  knobs: Knobs;
  population: { llm: number; bot: number; models: string[] };
  cost: { sessions: number; tokens_in: number; tokens_out: number; cost_usd: number };
};

const TOKEN_KEY = 'agent-economy-admin-token';

export function savedToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private mode or blocked storage: the token lives for this page only.
  }
}

async function admin<T>(token: string, path: string): Promise<T> {
  const response = await fetch(path, { headers: { 'x-admin-token': token } });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export const listRuns = (token: string) =>
  admin<{ runs: RunListing[] }>(token, '/admin/runs').then((r) => r.runs);

export const fetchEvents = async (token: string, runId: string): Promise<Event[]> => {
  const { events } = await admin<{ events: unknown[] }>(token, `/admin/runs/${runId}/events`);
  return events.map((e) => Event.parse(e));
};

export type PlanVersion = {
  turn: number;
  round: number | null;
  plan: { early: string; mid: string; late: string; now: string; thoughts: string };
};

export const fetchPlans = (token: string, runId: string, company: string) =>
  admin<{ plans: PlanVersion[] }>(token, `/admin/runs/${runId}/plans/${company}`).then(
    (r) => r.plans,
  );

export const fetchNotes = (token: string, runId: string, company: string) =>
  admin<{ text: string }>(token, `/admin/runs/${runId}/notes/${company}`).then((r) => r.text);

export type CostBucket = {
  sessions: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
};
export type Cost = {
  by_company: Record<string, CostBucket>;
  by_model: Record<string, CostBucket>;
  by_turn: Record<string, CostBucket>;
};

export const fetchCost = (token: string, runId: string) =>
  admin<Cost>(token, `/admin/runs/${runId}/cost`);

/** Download the raw event log as JSON. A plain link cannot carry the admin header. */
export async function exportEvents(token: string, runId: string): Promise<void> {
  const response = await fetch(`/admin/runs/${runId}/events`, {
    headers: { 'x-admin-token': token },
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `${runId}-events.json`;
  a.click();
  URL.revokeObjectURL(url);
}
