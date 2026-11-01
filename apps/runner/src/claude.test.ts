import { describe, expect, it } from 'vitest';
import { classify } from './claude.ts';

// The runner pauses on a quota message and hands off on anything else, so the classifier must
// know every wording the CLI uses for a limit. The subscription wording is from a real night.

describe('classify', () => {
  it('reads subscription and API limit messages as quota', () => {
    for (const text of [
      "You've hit your 5-hour limit · resets 8:30am (America/Chicago)",
      'You have hit your weekly limit',
      'rate limit exceeded',
      'HTTP 429 too many requests',
      'usage limit reached',
      'API is overloaded',
    ]) {
      expect(classify(text), text).toBe('quota');
    }
  });
  it('leaves other failures as errors', () => {
    expect(classify('MCP server failed to start')).toBe('error');
    expect(classify('Unexpected token in JSON')).toBe('error');
  });
});
