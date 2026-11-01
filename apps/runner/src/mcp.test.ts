import path from 'node:path';
import { buildServer, MemoryStore } from '@agent-economy/api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMcpServer, GameClient } from './mcp.ts';

// A real API on an ephemeral port, a real MCP client over an in-memory transport, and the
// tools in between. The text each tool returns is the API's JSON, unchanged.

const config = {
  seed: 9,
  experiment_id: 'mcp-test',
  population: [
    {
      id: 'c01',
      name: 'Ironreach',
      role: 'miner',
      driver: { kind: 'bot', strategy: 'honest_trader' },
    },
    {
      id: 'c05',
      name: 'Emberworks',
      role: 'smelter',
      driver: { kind: 'bot', strategy: 'honest_trader' },
    },
  ],
  limits: { round_wall_clock_seconds: 3600 },
};

let app: Awaited<ReturnType<typeof buildServer>>;
let client: Client;

beforeAll(async () => {
  app = await buildServer({
    store: new MemoryStore(),
    adminToken: 'admin',
    docsDir: path.resolve(import.meta.dirname, '../../../docs/agent'),
  });
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const created = await app.inject({
    method: 'POST',
    url: '/admin/runs',
    headers: { 'x-admin-token': 'admin' },
    payload: config,
  });
  const { tokens } = created.json() as { tokens: Record<string, string> };
  const server = buildMcpServer(new GameClient({ baseUrl, token: tokens.c01 ?? '' }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await app.close();
});

const text = (result: Awaited<ReturnType<Client['callTool']>>): string => {
  const content = result.content as { type: string; text?: string }[];
  return content[0]?.text ?? '';
};

describe('mcp tools', () => {
  it('lists one tool per endpoint', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'bug_report',
      'contracts',
      'docs',
      'market',
      'messages',
      'observation',
      'past_actions',
      'read_notes',
      'submit_actions',
      'write_notes',
    ]);
  });

  it('observes, submits, and reads back, spending the budget as it goes', async () => {
    const seen = JSON.parse(text(await client.callTool({ name: 'observation', arguments: {} })));
    expect(seen).toMatchObject({
      turn: 1,
      round: 1,
      you: { id: 'c01' },
      round_budget: { tool_calls_left: 7 },
    });

    const submitted = JSON.parse(
      text(
        await client.callTool({
          name: 'submit_actions',
          arguments: {
            actions: [
              { type: 'extract', from: { kind: 'ore_pit' }, qty: 12 },
              { type: 'produce', good: 'ingot', qty: 1 },
            ],
          },
        }),
      ),
    );
    expect(submitted.results).toEqual([
      { ok: true },
      { ok: false, code: 'NOT_LICENSED', reason: 'ingot needs the smelter license' },
    ]);

    const docs = JSON.parse(text(await client.callTool({ name: 'docs', arguments: {} })));
    expect(docs.files).toContain('rules.md');
    expect(
      text(await client.callTool({ name: 'docs', arguments: { file: 'recipes.md' } })),
    ).toContain('| miner |');

    await client.callTool({ name: 'write_notes', arguments: { text: 'sell ore to c05' } });
    expect(JSON.parse(text(await client.callTool({ name: 'read_notes', arguments: {} })))).toEqual({
      text: 'sell ore to c05',
    });

    const history = JSON.parse(
      text(await client.callTool({ name: 'past_actions', arguments: { turn: 1 } })),
    );
    expect(history.actions).toHaveLength(2);
  });

  it('passes the API error envelope through once the budget is spent', async () => {
    let last = '';
    for (let i = 0; i < 3; i++)
      last = text(await client.callTool({ name: 'market', arguments: {} }));
    expect(last).toContain('HTTP 409');
    expect(last).toContain('ROUND_CLOSED');
  });
});
