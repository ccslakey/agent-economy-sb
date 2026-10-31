import type { Turn } from '@agent-economy/schema';

/**
 * Uniform draw in [0, 1), deterministic in (seed, turn, purpose). Counter-free, so there is no
 * RNG state to persist: a crashed run resumes at the next turn with identical randomness, and
 * replay needs no RNG because every draw's effect is already in an event.
 */
export type Rng = (purpose: string) => number;

// cyrb53: a 53-bit string hash with good dispersion, small enough to read.
function hash53(input: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function rngFor(seed: number, turn: Turn): Rng {
  return (purpose) => hash53(`${seed}|${turn}|${purpose}`) / 2 ** 53;
}
