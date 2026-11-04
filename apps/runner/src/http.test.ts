import { describe, expect, it } from 'vitest';
import { fetchRetrying } from './http.ts';

const reset = () => new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });

describe('fetchRetrying', () => {
  it('retries a request that got no answer and returns the first response', async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    const logged: string[] = [];
    let n = 0;
    const response = await fetchRetrying(
      'http://api/admin/runs',
      { method: 'POST' },
      {
        fetchImpl: async (input) => {
          calls.push(input);
          n += 1;
          if (n < 3) throw reset();
          return new Response('ok', { status: 200 });
        },
        sleep: async (ms) => {
          waits.push(ms);
        },
        log: (line) => logged.push(line),
      },
    );
    expect(await response.text()).toBe('ok');
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
    expect(logged[0]).toMatch(
      /^POST http:\/\/api\/admin\/runs failed \(fetch failed: read ECONNRESET\), retrying in 1000ms$/,
    );
  });

  it('hands back an error response without retrying, since the server did answer', async () => {
    let n = 0;
    const response = await fetchRetrying('http://api/x', undefined, {
      fetchImpl: async () => {
        n += 1;
        return new Response('no', { status: 500 });
      },
      sleep: async () => undefined,
    });
    expect(response.status).toBe(500);
    expect(n).toBe(1);
  });

  it('gives up after the last attempt with the last error', async () => {
    let n = 0;
    await expect(
      fetchRetrying('http://api/x', undefined, {
        attempts: 3,
        fetchImpl: async () => {
          n += 1;
          throw reset();
        },
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('fetch failed');
    expect(n).toBe(3);
  });
});
