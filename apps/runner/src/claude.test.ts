import { describe, expect, it } from 'vitest';
import { classify, cliArgs, sessionEnv } from './claude.ts';

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

describe('cli arguments and environment', () => {
  const request = {
    prompt: 'play',
    systemPrompt: 'you run a company',
    model: 'sonnet',
    effort: 'medium',
    harnessVersion: 1,
    mcpConfigPath: '/tmp/mcp.json',
    cwd: '/tmp',
  };

  it('passes a Claude model through and loads every settings source under harness 1', () => {
    const args = cliArgs(request);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'sonnet',
    ]);
    expect(args).not.toContain('--setting-sources');
    expect(sessionEnv('sonnet', { PATH: '/bin' })).toEqual({
      PATH: '/bin',
      MCP_TOOL_TIMEOUT: '3600000',
    });
  });

  it('loads project settings only under harness 2, so the user plugins stay out of the prompt', () => {
    const args = cliArgs({ ...request, harnessVersion: 2 });
    expect(
      args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2),
    ).toEqual(['--setting-sources', 'project']);
  });

  it('serves an ollama/ model from the local Ollama through the Anthropic-compatible endpoint', () => {
    const args = cliArgs({ ...request, model: 'ollama/qwen3-coder:30b' });
    expect(args[args.indexOf('--model') + 1]).toBe('qwen3-coder:30b');
    expect(sessionEnv('ollama/qwen3-coder:30b', { PATH: '/bin' })).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://localhost:11434',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: '',
    });
    expect(
      sessionEnv('ollama/qwen3-coder:30b', { OLLAMA_HOST: 'http://box:11434' }).ANTHROPIC_BASE_URL,
    ).toBe('http://box:11434');
  });
});
