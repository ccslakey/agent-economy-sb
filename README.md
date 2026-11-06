# Agent Economy Sandbox

A turn-based economy where LLM agents each run a company, trade through unenforced contracts, and talk to each other. The spec is `Agent Economy Sandbox Spec v0.2.md`, and `docs/experiments.md` logs every run and sweep.

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

Create a run from a JSON config (same shape as `configs/baseline.yaml`) and keep the tokens it returns:

```sh
curl -s -X POST localhost:3000/admin/runs -H 'x-admin-token: change-me' \
  -H 'content-type: application/json' -d '{"seed":1,"experiment_id":"try",
  "population":[{"id":"c01","name":"Ironreach","role":"miner","driver":{"kind":"bot","strategy":"honest_trader"}},
                {"id":"c05","name":"Emberworks","role":"smelter","driver":{"kind":"bot","strategy":"honest_trader"}}]}'
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

## Drive a run with headless Claude Code

Write a run config with `driver: { kind: llm, model: sonnet, effort: low, harness_version: 1, prompt_variant: neutral }` for each LLM company and `driver: { kind: bot, strategy: honest_trader }` for each bot, then:

```sh
ADMIN_TOKEN=change-me node apps/runner/src/run.ts --api http://localhost:3000 --config configs/my-run.yaml
```

The runner creates the run, plays every round (LLM companies through `claude -p` with only the game tools, bots through the API), records a trace per session, pauses the run on a quota limit and resumes after a wait, hands a company to the honest trader bot after three failed sessions, and asks each LLM agent the farming questions when the game ends. Pass `--run <id>` to pick up an existing run.

The dashboard's overview lists each run's notable moments (default waves, bankruptcies, shocks and the price reaction, lead changes, stalled trade), detected from the log by `packages/engine/src/moments.ts` with every claim citing event ids.

## Start the API

```sh
DATABASE_URL=postgres://localhost/agent_economy ADMIN_TOKEN=change-me PORT=3000 pnpm api
```

`pnpm api` runs the API under nodemon and restarts it when anything under the API, engine, schema, or agent docs changes.

## Inspect a run

```sh
API_URL=http://localhost:3000 pnpm dashboard
```

Open the printed URL, paste the admin token, and pick a run from the list. The views fold the event log in the browser, so the turn scrubber works on any run.

## Run a sweep

```sh
ADMIN_TOKEN=change-me node apps/runner/src/sweep.ts --api http://localhost:3000 --sweep configs/sweeps/m6-knobs.yaml --concurrency 2
ADMIN_TOKEN=change-me node apps/runner/src/sweep.ts --api http://localhost:3000 --compare m6-knobs
ADMIN_TOKEN=change-me node apps/runner/src/sweep.ts --api http://localhost:3000 --focal m7-focal,m7-focal-opus
DATABASE_URL=postgres:///agent_economy node apps/runner/src/backfill-provenance.ts
ADMIN_TOKEN=change-me node apps/runner/src/sweep.ts --api http://localhost:3000 --sweep configs/sweeps/m7-focal-qwen3-coder.yaml --concurrency 1
```

A sweep file names a base config, a seed list, and the variants to compare. Every variant plays every seed, a few runs at a time, and the comparison table pairs runs by seed against the first variant. Rerunning a sweep skips the runs that already ended, so an interrupted night picks up where it stopped. `--compare` prints the table for runs already played; a variant and seed played more than once counts its latest clean run only. Several experiments, comma separated, print one table across them paired by seed, and every table ends with the provenance fields that differ among its runs. `backfill-provenance.ts` gives runs from before provenance was recorded the inferred revision and `unknown` for the rest. A driver model named `ollama/<name>` plays through a local Ollama (`OLLAMA_HOST` overrides `http://localhost:11434`); `configs/sweeps/m7-focal-*.yaml` hold one focal sweep per model under harness version 2, paired by `--focal m7-focal-sonnet,m7-focal-<model>`. `DATABASE_URL=... node apps/runner/src/seed-db.ts` stores a bot game to look at without spending a session.
