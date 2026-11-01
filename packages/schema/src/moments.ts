import { z } from 'zod';
import { EventId } from './ids.ts';
import { Turn } from './world.ts';

// Notable moments: an LLM-written narrative of a run, every claim tied to event ids. The runner
// writes them after checking each citation against the log; the dashboard shows what survived.

export const Moment = z.object({
  from_turn: Turn,
  to_turn: Turn,
  text: z.string().min(1).max(1500),
  /** Ids that passed the check: each names an event in the log inside the turn range. */
  events: z.array(EventId),
  /** How many ids the writer cited before the check, so a reader can see what was dropped. */
  cited: z.number().int().nonnegative(),
});
export type Moment = z.infer<typeof Moment>;

export const RunMoments = z.object({
  generated_at: z.string().min(1),
  model: z.string().min(1),
  moments: z.array(Moment).max(20),
});
export type RunMoments = z.infer<typeof RunMoments>;
