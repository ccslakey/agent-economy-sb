import { z } from 'zod';

// Branded ids. Validated once where data enters (config, API body, event row); trusted after.
// The patterns match the spec's examples (c07, g1, k112) so a swapped id fails to parse.

export const RunId = z.string().min(1).brand<'RunId'>();
export type RunId = z.infer<typeof RunId>;

export const CompanyId = z
  .string()
  .regex(/^c\d{2,}$/)
  .brand<'CompanyId'>();
export type CompanyId = z.infer<typeof CompanyId>;

export const GroveId = z
  .string()
  .regex(/^g\d+$/)
  .brand<'GroveId'>();
export type GroveId = z.infer<typeof GroveId>;

export const ContractId = z
  .string()
  .regex(/^k\d+$/)
  .brand<'ContractId'>();
export type ContractId = z.infer<typeof ContractId>;

/** `<run_id>:<seq>`. Stable and citable: the dashboard checks every id a narrative cites. */
export const EventId = z
  .string()
  .regex(/^.+:\d+$/)
  .brand<'EventId'>();
export type EventId = z.infer<typeof EventId>;

// The engine mints ids through these so it never needs a cast.
export const groveId = (n: number): GroveId => GroveId.parse(`g${n}`);
export const contractId = (n: number): ContractId => ContractId.parse(`k${n}`);
export const eventId = (run: RunId, seq: number): EventId => EventId.parse(`${run}:${seq}`);
