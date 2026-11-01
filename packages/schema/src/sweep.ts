import { z } from 'zod';
import { PopulationEntry, RunConfig } from './config.ts';

// A sweep is one experiment: a base config, a list of seeds, and the knob settings to compare.
// Runs pair by seed across variants, so every difference in a pair comes from the variant.

const Overrides = z.record(z.string(), z.unknown()).default({});

export const SweepVariant = z.object({
  name: z.string().min(1),
  knobs: Overrides,
  economy: Overrides,
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
  return sweep.variants.flatMap((variant) =>
    sweep.seeds.map((seed) => ({
      variant: variant.name,
      seed,
      config: RunConfig.parse({
        seed,
        experiment_id: `${sweep.experiment_id}/${variant.name}`,
        population: sweep.base.population,
        economy: { ...sweep.base.economy, ...variant.economy },
        knobs: { ...sweep.base.knobs, ...variant.knobs },
        limits: sweep.base.limits,
      }),
    })),
  );
}
