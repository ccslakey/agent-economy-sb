import { spawn } from 'node:child_process';
import { z } from 'zod';

// The Claude Code adapter: one headless session per call. Spawns `claude -p` with only the game
// MCP tools, reads the JSON result, and classifies failures so the runner can pause on quota,
// retry on transient errors, and hand a company to a bot when nothing works.

export type SessionRequest = {
  prompt: string;
  systemPrompt: string;
  model: string;
  effort: string;
  mcpConfigPath: string;
  /** A session id to continue, for the per_turn context knob. */
  resume?: string;
  cwd: string;
};

export type SessionResult =
  | {
      ok: true;
      sessionId: string | null;
      result: string;
      raw: Record<string, unknown>;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
      durationMs: number;
    }
  | {
      ok: false;
      kind: 'quota' | 'error';
      message: string;
      raw: Record<string, unknown>;
      durationMs: number;
    };

export type Spawner = (request: SessionRequest) => Promise<SessionResult>;

const Output = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
});

const QUOTA = /rate limit|usage limit|too many requests|429|overloaded|quota|capacity/i;

export function classify(text: string): 'quota' | 'error' {
  return QUOTA.test(text) ? 'quota' : 'error';
}

export function cliArgs(request: SessionRequest): string[] {
  return [
    '-p',
    request.prompt,
    '--model',
    request.model,
    '--effort',
    request.effort,
    '--append-system-prompt',
    request.systemPrompt,
    '--mcp-config',
    request.mcpConfigPath,
    '--strict-mcp-config',
    '--tools',
    '',
    '--allowedTools',
    'mcp__game__*',
    '--permission-mode',
    'dontAsk',
    '--output-format',
    'json',
    ...(request.resume === undefined ? [] : ['--resume', request.resume]),
  ];
}

/** Turn the CLI's stdout, stderr, and exit code into a SessionResult. Exported for tests. */
export function interpret(
  stdout: string,
  stderr: string,
  code: number | null,
  durationMs: number,
): SessionResult {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  const out = Output.safeParse(parsed);
  const raw: Record<string, unknown> =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : { stdout, stderr };
  if (!out.success || code !== 0 || out.data.is_error === true) {
    const message = out.success
      ? (out.data.result ?? out.data.subtype ?? 'error')
      : stderr || stdout;
    return {
      ok: false,
      kind: classify(`${message}\n${stderr}`),
      message: message.slice(0, 2000),
      raw,
      durationMs,
    };
  }
  const usage = out.data.usage ?? {};
  return {
    ok: true,
    sessionId: out.data.session_id ?? null,
    result: out.data.result ?? '',
    raw,
    tokensIn:
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
    tokensOut: usage.output_tokens ?? 0,
    costUsd: out.data.total_cost_usd ?? 0,
    durationMs: out.data.duration_ms ?? durationMs,
  };
}

export const claudeSpawner: Spawner = (request) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('claude', cliArgs(request), {
      cwd: request.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({
        ok: false,
        kind: 'error',
        message: error.message,
        raw: { stderr },
        durationMs: Date.now() - started,
      });
    });
    child.on('close', (code) => resolve(interpret(stdout, stderr, code, Date.now() - started)));
  });
