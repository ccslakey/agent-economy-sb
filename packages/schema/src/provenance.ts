import { z } from 'zod';

// What played a run, beyond its config: the source revision, the CLI, and the exact prompt and
// docs the agents read. Two runs months apart compare only if these match or the difference is
// known. The model the CLI resolved an alias to lives in each trace's result; the provenance
// route reads it from there. A run from before provenance was recorded can be backfilled from
// what can still be proved: the revision is the last commit before the run started, marked
// `-inferred`, and whatever cannot be inferred is `unknown`.

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex sha256');
const Digest = Sha256.or(z.literal('unknown'));

export const Provenance = z.object({
  /** `git rev-parse HEAD` of the runner's source, with `-dirty` appended when the tree had uncommitted changes, or `-inferred` when backfilled from the run's start time. */
  source_revision: z.string().min(1),
  /** Output of `claude --version`, or `unknown` when the CLI could not be asked. */
  cli_version: z.string().min(1),
  /** The system prompt file the runner passed, by name and by content. */
  prompt_variant: z.string().min(1),
  prompt_sha256: Digest,
  /** One digest over every file the docs tool serves, in name order, so a wording change is visible. */
  docs_sha256: Digest,
  recorded_at: z.iso.datetime(),
});
export type Provenance = z.infer<typeof Provenance>;
