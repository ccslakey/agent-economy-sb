import { z } from 'zod';
import { Driver, PopulationEntry, RunConfig } from './config.ts';
import { CompanyId } from './ids.ts';

// A sweep is one experiment: a base config, a list of seeds, and the knob settings to compare.
// Runs pair by seed across variants, so every difference in a pair comes from the variant.

const Overrides = z.record(z.string(), z.unknown()).default({});

export const SweepVariant = z.object({
  name: z.string().min(1),
  knobs: Overrides,
  economy: Overrides,
  limits: Overrides,
  /** Replaces the base population outright, for a variant that changes who plays. */
  population: z.array(PopulationEntry).min(1).optional(),
  /** Replaces the driver of these companies only, for a variant that changes who plays one seat. */
  drivers: z.record(CompanyId, Driver).default({}),
});
export type SweepVariant = z.infer<typeof SweepVariant>;

export const Sweep = z.object({
  experiment_id: z.string().min(1),
  seeds: z.array(z.number().int().nonnegative()).min(1),
  base: z.object({
    population: z.array(PopulationEntry).min(1),
    economy: Overrides,
    knobs: Overrides,
    limits: Overrides,
  }),
  variants: z.array(SweepVariant).min(1),
});
export type Sweep = z.infer<typeof Sweep>;

export type SweepRun = { variant: string; seed: number; config: RunConfig };

/** Every run the sweep calls for, variant by variant, with `experiment_id` as `<sweep>/<variant>`. */
export function expandSweep(sweep: Sweep): SweepRun[] {
  return sweep.variants.flatMap((variant) => {
    const population = (variant.population ?? sweep.base.population).map((entry) => {
      const driver = variant.drivers[entry.id];
      return driver === undefined ? entry : { ...entry, driver };
    });
    for (const id of Object.keys(variant.drivers)) {
      if (!population.some((entry) => entry.id === id)) {
        throw new Error(
          `variant ${variant.name}: drivers names ${id}, which is not in the population`,
        );
      }
    }
    return sweep.seeds.map((seed) => ({
      variant: variant.name,
      seed,
      config: RunConfig.parse({
        seed,
        experiment_id: `${sweep.experiment_id}/${variant.name}`,
        population,
        economy: { ...sweep.base.economy, ...variant.economy },
        knobs: { ...sweep.base.knobs, ...variant.knobs },
        limits: { ...sweep.base.limits, ...variant.limits },
      }),
    }));
  });
}
