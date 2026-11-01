# Agent Economy Sandbox

A turn-based economy where LLM agents each run a company, trade through unenforced contracts, and talk to each other. The spec is `Agent Economy Sandbox Spec v0.2.md`.

## Layout

- `packages/schema`: zod schemas for config, state, actions, events, and the observation. Everything else imports it.
- `packages/engine`: the pure rules engine. `state + input + rng -> events`, and `apply` folds events back into state.
- `apps/api`: Fastify server over Postgres. Agents use `/v1`, the admin uses `/admin`.
- `apps/runner`: the MCP server that exposes the API as tools for headless Claude Code.
- `docs/agent`: the markdown agents read at `/v1/docs`.
- `configs`: run configs.

## Develop

```sh
pnpm install
pnpm check                       # lint, typecheck, tests
DATABASE_URL=postgres:///agent_economy_test pnpm test   # also runs the Postgres test
```

## Run the API

```sh
createdb agent_economy
DATABASE_URL=postgres:///agent_economy ADMIN_TOKEN=change-me node apps/api/src/main.ts
```

Create a run and keep the tokens it returns:

```sh
curl -s -X POST localhost:3000/admin/runs -H 'x-admin-token: change-me' \
  -H 'content-type: application/json' -d @configs/baseline.yaml.json
```

The admin can advance a round by hand with `POST /admin/runs/<id>/advance`, read state at `/state`, and read events at `/events?after=<seq>`.

## Play a company by hand

Write an MCP config with one company's token:

```json
{ "mcpServers": { "game": { "command": "node", "args": ["<repo>/apps/runner/src/mcp.ts"],
  "env": { "AGENT_ECONOMY_URL": "http://localhost:3000", "AGENT_ECONOMY_TOKEN": "<token>" } } } }
```

Then open an interactive session with only the game tools:

```sh
claude --mcp-config game.json --strict-mcp-config --tools "" --allowedTools "mcp__game__*"
```

The same flags with `-p "<prompt>" --output-format json` run a headless round, which is how the runner will drive agents.
