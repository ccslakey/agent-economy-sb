# Observing agent thinking: plan

Three questions drive this work. How do agents track obligations against round timing, and why do they default? How do they handle multi-turn escrow and the working capital it locks? How do they choose partners after an attributable default? Behind them sits one requirement: any difference we report must be attributable to memory, to reputation, or to the model, not to a mix of the three.

The first knob sweeps (spec, Decisions, M6 entries) showed why the order below matters. Fresh-session agents defaulted on 55% of contracts and their debriefs blamed thin notes and a tool budget spent re-reading state. The same agents kept awake for the whole game defaulted on 6% and produced ten times the welfare. Enforcement and penalty knobs that did nothing for forgetful agents mattered once agents could remember. So memory is the first confound to control, and evidence of what each agent saw is the first thing to capture.

## Working rules

- The economic rules stay fixed: atomic escrow, settlement at the due turn, penalties destroyed. Observability changes show the agent more, never decide for it.
- Each step is one pull request under 500 lines that ends in a check a reviewer can rerun.
- Live sweeps are a separate instruction from the user. Each sweep's result goes into the spec's Decisions section with its paired table and its caveats.
- Awake mode (`context_persistence: persistent`) is the default for behavior experiments. Fresh sessions are a memory condition, not the baseline.
- A default label describes observable behavior. An agent's own account is supporting evidence, never the record.

## Steps

### 1. Capture what the agent saw, and fix the two false sentences

- [x] **Tool-call log.** The MCP server records every tool call: tool, input, output, duration, and the turn and round the API saw at that moment. Stored per run and company, listed from an admin route, exempt from the round budget. Works for any agent product because it lives in our server, not in the CLI's output format.
- [x] **Rules wording.** `rules.md` no longer tells every agent that notes and plan are its only memory, which is false in awake mode, and its horizon section no longer says there is no known last turn, which is false under a fixed horizon.
- [ ] **Assistant text.** Optional: capture the agent's own messages between tool calls through the CLI's streaming output. Only if the tool-call log leaves "why" questions open.

Done when a run's tool-call log reconstructs, for any company, what it read and did in each round.

### 2. Put obligations, commitments, and submission status in the observation

- [x] **Obligations.** For each active contract the observation lists what you owe and are owed, the quantity still to deposit, the counterparty, the due turn, and the status. Both parties see the same contract from their own side.
- [x] **Commitments and escrow.** The observation lists what you have deposited and not yet received back, and what you have promised and not yet deposited, so working capital locked in multi-turn contracts is visible. Available cash and inventory already exclude deposits.
- [x] **Submission status.** The observation says whether this round's batch is in, and whether it was empty.

Done when an agent can act on an obligation without spending a tool call on the contracts route, and a test covers a contract seen from each party.

### 3. Annotate defaults and partner choice over the runs we already have

- [x] **Default mechanism.** For every default in every ended run: did the failing party attempt the deposit (a deliver or pay action), was the attempt rejected and why, did it hold the goods or cash at the last actionable round, and did it have competing obligations due the same turn. Labels may overlap. Output is a table per run and a rollup per variant.
- [x] **Partner choice.** For every proposal after an attributable default: did the proposer have a visible default by the counterparty in the ledger, had the proposer itself been defaulted on by that counterparty, did it switch suppliers, and did it broadcast to several suppliers at once. Reports repeat exchange, switching, and the price paid relative to the reference price.
- [x] **Working capital.** Per company per turn: cash, inventory value, deposits in escrow, and promised but undeposited value, so a cash squeeze from locked escrow is visible as a series.

Done when the three reports run against the existing database and `docs/experiments.md` records what they say about the first runs.

### 4. Isolate memory

- [x] **Notes toggle.** A knob turns notes and plan off. Reads return empty and writes are refused with a clear error.
- [x] **History policy.** One knob governs access to past actions, contract history, and message history, so a fresh-session agent with notes off has no memory channel. Current obligations stay visible through step 2.
- [ ] **Four-cell sweep.** Conversation retained or not, by notes retained or not, ten seeds, awake baseline otherwise. Public reputation hidden so memory is the only channel for a counterparty's record.

Done when the spec records the four-cell table and names which cell the earlier results belong to.

### 5. Isolate reputation and model

- [ ] **Reputation sweep.** The existing reputation visibility knob (public, own only, hidden), ten seeds, awake mode, twelve companies so every good has two suppliers, with step 3's partner-choice report as the outcome.
- [ ] **Focal company.** One LLM company among scripted counterparties, rotated through all six roles, ten seeds per role, compared with the honest-trader bot in the same seat. The bots already propose pay-on-delivery purchases and shun visible defaulters, so the environment responds. Repeat per model to compare models with the population held fixed.
- [x] **Provenance.** Each run records the source revision, the CLI version, the resolved model id, and the prompt and docs versions, so a comparison across months is still a comparison.

Done when the spec has one table per question with paired differences and a seed count, and names the model as a system result (software plus model), not a model claim.

## Deferred

Scenario fixtures with held-out cases, scripted trajectories as evaluator tests, and a pilot manifest are good science and each is a week of work. None is needed to answer the three questions from the runs we have, so they wait until steps 1 to 5 show which scenarios matter.

## Handoff

Keep this block current at the end of each step.

```text
Current step: 5
Status: Provenance recorded per run; memory sweep config ready in configs/sweeps/m6-memory.yaml, not yet run
Branch: unit-20-provenance
Last completed: step 5 provenance (source revision, CLI version, prompt and docs digests, resolved model ids)
Next action: focal-company sweep shape and per-seat report, reputation sweep config; then run the sweeps when the user says so
```
