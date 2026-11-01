import { eventId, RunId } from '@agent-economy/schema';
import { describe, expect, it } from 'vitest';
import { check, digest, parse } from './narrate.ts';
import { playBots, roster } from './play.ts';

// The narrator is an LLM; what we test is the fence around it: the digest it reads is citable
// and the check lets only real, in-range citations through.

const run = RunId.parse('r-narrate');
const config = roster(
  (role, slot) => (role === 'smelter' && slot === 1 ? 'defector' : 'honest_trader'),
  { knobs: { horizon: { kind: 'fixed', last_turn: 4 } } },
);
const [started, ...rest] = playBots(config, run).log;
if (started?.type !== 'run_started') throw new Error('no run_started');

describe('narrate', () => {
  it('digests a bot game into lines the narrator can cite', () => {
    const text = digest(started, rest);
    const cited = rest.filter((e) => text.includes(`[${e.id}]`));
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((e) => e.type !== 'extraction_completed')).toBe(true);
    expect(text).toContain('Companies (id, name, role, driver');
  });

  it('keeps only citations that exist and fall inside the turn range', () => {
    const turn2 = rest.find((e) => e.turn === 2 && e.type === 'contract_accepted');
    const turn4 = rest.find((e) => e.turn === 4);
    if (turn2 === undefined || turn4 === undefined) throw new Error('fixture too quiet');
    const kept = check(
      [
        {
          from_turn: 2,
          to_turn: 2,
          text: 'real and in range',
          events: [turn2.id, turn4.id, eventId(run, 99999), 'not-an-id', turn2.id],
        },
        { from_turn: 1, to_turn: 1, text: 'nothing resolves', events: [eventId(run, 99999)] },
      ],
      rest,
    );
    expect(kept).toEqual([
      { from_turn: 2, to_turn: 2, text: 'real and in range', events: [turn2.id], cited: 5 },
    ]);
  });

  it('parses an array wrapped in prose or a code fence', () => {
    const reply =
      'Here you go:\n```json\n[{"from_turn":1,"to_turn":2,"text":"x","events":["a"]}]\n```';
    expect(parse(reply)).toEqual([{ from_turn: 1, to_turn: 2, text: 'x', events: ['a'] }]);
    expect(() => parse('no array here')).toThrow();
  });
});
