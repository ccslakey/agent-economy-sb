// The runner's one way to reach the API. A sweep runs for hours against a local server, and a
// single dropped connection (ECONNRESET on a read, a refused socket during a restart) must not
// end it. Only a request that never got an answer is retried: a response, even an error one, is
// handed back as is, because the request did reach the server and retrying it could repeat an
// action.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RetryOptions = {
  attempts?: number;
  /** Wait before retry number n (1-based). Doubles from one second by default. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
};

export async function fetchRetrying(
  input: string,
  init?: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const attempts = options.attempts ?? 5;
  const backoffMs = options.backoffMs ?? ((n) => 1000 * 2 ** (n - 1));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = options.fetchImpl ?? ((i, o) => fetch(i, o));
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      failure = error;
      if (attempt === attempts) break;
      const wait = backoffMs(attempt);
      options.log?.(
        `${init?.method ?? 'GET'} ${input} failed (${describe(error)}), retrying in ${wait}ms`,
      );
      await sleep(wait);
    }
  }
  throw failure;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}
