#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// The game API as MCP tools, one per endpoint. A thin wrapper: every tool is one HTTP call with
// the company's bearer token, and the API's own error envelope comes back as the tool result.
// Headless Claude Code loads it with --mcp-config, and nothing else is exposed to the agent.

export type GameClientOptions = { baseUrl: string; token: string; fetch?: typeof fetch };

export class GameClient {
  private readonly options: GameClientOptions;
  private readonly fetchImpl: typeof fetch;
  constructor(options: GameClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<string> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return response.ok ? text : `HTTP ${response.status}: ${text}`;
  }
}

const Text = z.string().min(1).max(500);

export type McpOptions = {
  /** Expose wait_for_round. Only a persistent session may block on it: in a per-round session it would hold the round open until the wall clock. */
  wait?: boolean;
};

export function buildMcpServer(client: GameClient, options: McpOptions = {}): McpServer {
  const server = new McpServer({ name: 'agent-economy', version: '0.1.0' });
  const asText = (promise: Promise<string>) =>
    promise.then((text) => ({ content: [{ type: 'text' as const, text }] }));
  type Reply = { content: { type: 'text'; text: string }[] };
  type Handler<A> = (args: A) => Promise<Reply>;
  /** Record the call with the API so the run's record shows what the agent read and did. The log never fails the tool. */
  const logged =
    <A>(tool: string, handler: Handler<A>): Handler<A> =>
    async (args) => {
      const started = Date.now();
      const reply = await handler(args);
      const output = reply.content.map((c) => c.text).join('');
      await client
        .call('POST', '/v1/calls', { tool, input: args, output, duration_ms: Date.now() - started })
        .catch(() => undefined);
      return reply;
    };

  server.registerTool(
    'observation',
    {
      description:
        'Your current view of the game: turn, round, cash, inventory, capacity, pending orders, companies, groves, last market prices, your contracts, new messages, reputation, and tool calls left this round.',
      inputSchema: {},
    },
    logged('observation', () => asText(client.call('GET', '/v1/observation'))),
  );

  server.registerTool(
    'submit_actions',
    {
      description:
        "Submit this round's batch of actions. One batch per round. Returns one result per action, in order. See the api.md doc for every action shape.",
      inputSchema: { actions: z.array(z.record(z.string(), z.unknown())) },
    },
    logged('submit_actions', ({ actions }) =>
      asText(client.call('POST', '/v1/actions', { actions })),
    ),
  );

  server.registerTool(
    'past_actions',
    {
      description: 'Your past action batches with per-action results, optionally for one turn.',
      inputSchema: { turn: z.number().int().optional() },
    },
    logged('past_actions', ({ turn }) =>
      asText(client.call('GET', `/v1/actions${turn === undefined ? '' : `?turn=${turn}`}`)),
    ),
  );

  server.registerTool(
    'contracts',
    {
      description:
        'Your contracts with full terms and status, optionally filtered by status: proposed, active, completed, defaulted, rejected, withdrawn, expired.',
      inputSchema: { status: z.string().optional() },
    },
    logged('contracts', ({ status }) =>
      asText(client.call('GET', `/v1/contracts${status === undefined ? '' : `?status=${status}`}`)),
    ),
  );

  server.registerTool(
    'messages',
    {
      description: 'Public messages and your direct messages, optionally for one turn.',
      inputSchema: { turn: z.number().int().optional() },
    },
    logged('messages', ({ turn }) =>
      asText(client.call('GET', `/v1/messages${turn === undefined ? '' : `?turn=${turn}`}`)),
    ),
  );

  server.registerTool(
    'market',
    {
      description: 'NPC market clearing quantity and price per final good for every past turn.',
      inputSchema: {},
    },
    logged('market', () => asText(client.call('GET', '/v1/market'))),
  );

  server.registerTool(
    'docs',
    {
      description:
        'The game documentation. Call with no file to list files, or with a file name (rules.md, recipes.md, contracts.md, api.md) to read it.',
      inputSchema: { file: z.string().optional() },
    },
    logged('docs', ({ file }) =>
      asText(
        client.call(
          'GET',
          file === undefined ? '/v1/docs' : `/v1/docs/${encodeURIComponent(file)}`,
        ),
      ),
    ),
  );

  server.registerTool(
    'read_plan',
    {
      description:
        'Your standing game plan: early, mid, and late game, what you are doing now, and your thoughts on how the game is going. Null before you write one.',
      inputSchema: {},
    },
    logged('read_plan', () => asText(client.call('GET', '/v1/plan'))),
  );

  server.registerTool(
    'write_plan',
    {
      description:
        'Write or revise your game plan. Give every field, each under 600 characters: early (your opening), mid (the middle game), late (the endgame), now (what you are doing this turn and why), thoughts (how you feel the game is going). Every revision is kept.',
      inputSchema: {
        early: z.string(),
        mid: z.string(),
        late: z.string(),
        now: z.string(),
        thoughts: z.string(),
      },
    },
    logged('write_plan', (plan) => asText(client.call('PUT', '/v1/plan', plan))),
  );

  server.registerTool(
    'read_notes',
    {
      description: 'Your private notes from earlier rounds. Your only memory between rounds.',
      inputSchema: {},
    },
    logged('read_notes', () => asText(client.call('GET', '/v1/notes'))),
  );

  server.registerTool(
    'write_notes',
    {
      description:
        'Replace your private notes. Keep them short; there is a length cap. Write what your future self needs to know.',
      inputSchema: { text: z.string() },
    },
    logged('write_notes', ({ text }) => asText(client.call('PUT', '/v1/notes', { text }))),
  );

  if (options.wait === true)
    server.registerTool(
      'wait_for_round',
      {
        description:
          'Wait until the next round opens, then return your fresh observation. Pass the turn and round you just acted in, from your observation. Returns status "ended" with the final scores when the game is over. Spends no tool call. For a session that plays the whole game.',
        inputSchema: { turn: z.number().int(), round: z.number().int() },
      },
      logged('wait_for_round', async ({ turn, round }) => {
        for (;;) {
          const text = await client.call('GET', `/v1/wait?turn=${turn}&round=${round}`);
          if (text.startsWith('HTTP ')) return { content: [{ type: 'text' as const, text }] };
          const { status } = JSON.parse(text) as { status: string };
          if (status !== 'waiting') return { content: [{ type: 'text' as const, text }] };
        }
      }),
    );

  server.registerTool(
    'bug_report',
    {
      description: 'Report anything confusing or broken about the game or this API.',
      inputSchema: { text: Text },
    },
    logged('bug_report', ({ text }) => asText(client.call('POST', '/v1/bug_report', { text }))),
  );

  return server;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const baseUrl = process.env.AGENT_ECONOMY_URL;
  const token = process.env.AGENT_ECONOMY_TOKEN;
  if (baseUrl === undefined || token === undefined) {
    throw new Error('set AGENT_ECONOMY_URL and AGENT_ECONOMY_TOKEN');
  }
  const server = buildMcpServer(new GameClient({ baseUrl, token }), {
    wait: process.env.AGENT_ECONOMY_PERSISTENT === '1',
  });
  await server.connect(new StdioServerTransport());
}
