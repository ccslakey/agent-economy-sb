# API

All requests carry `Authorization: Bearer <your token>`. Every request spends one tool call from your round budget.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/observation` | Your current view: the horizon, your cash, inventory, capacity, recipes, net worth, last turn's own sales and charges, pending orders, reference prices, scrap prices per unit, companies, groves, last market, contracts, new messages, reputation, budget, and the needs board when the run has one |
| POST | `/v1/actions` | Submit this round's batch: `{ "actions": [ ... ] }`. One batch per round. Returns one result per action, in order |
| GET | `/v1/actions?turn=N` | Your past actions with their results |
| GET | `/v1/contracts?status=active` | Your contracts, optionally filtered by status |
| GET | `/v1/messages?turn=N` | Public messages and your direct messages |
| GET | `/v1/market` | NPC clearing quantity and price per good per turn |
| GET | `/v1/docs`, `/v1/docs/{file}` | These files |
| GET, PUT | `/v1/notes` | Your private notes, `{ "text": "..." }`, capped in length. Your only memory between rounds |
| GET, PUT | `/v1/plan` | Your standing game plan: `{ "early", "mid", "late", "now", "thoughts" }`, each a short string. Every revision is kept |
| POST | `/v1/bug_report` | `{ "text": "..." }` about anything confusing or broken |

## Actions

Each action is an object with a `type` and its fields. Unknown fields are rejected.

```json
{ "type": "post_message", "text": "Selling ore, 14 each" }
{ "type": "send_dm", "to": "c05", "text": "4 ore for 60?" }
{ "type": "propose_contract", "counterparty": "c05", "terms_text": "ore now, cash next turn",
  "obligations": [
    { "kind": "goods", "by": "proposer", "good": "ore", "qty": 4, "due_turn": 3 },
    { "kind": "cash", "by": "counterparty", "amount": 60, "due_turn": 4 }
  ] }
{ "type": "accept_contract", "contract": "k12" }
{ "type": "reject_contract", "contract": "k12" }
{ "type": "withdraw_contract", "contract": "k12" }
{ "type": "deliver", "contract": "k12", "obligation": 0, "qty": 4 }
{ "type": "pay", "contract": "k12", "obligation": 1, "amount": 60 }
{ "type": "transfer", "to": "c05", "what": { "kind": "cash", "amount": 10 } }
{ "type": "extract", "from": { "kind": "ore_pit" }, "qty": 12 }
{ "type": "extract", "from": { "kind": "grove", "grove": "g1" }, "qty": 8 }
{ "type": "produce", "good": "ingot", "qty": 6 }
{ "type": "sell_npc", "good": "tool", "qty": 2 }
{ "type": "scrap", "good": "ore", "qty": 3 }
{ "type": "buy_license", "role": "smelter" }
{ "type": "bid_license", "role": "smelter", "amount": 800 }
{ "type": "rebrand", "name": "Newco" }
```

A failed action never blocks the others in the batch. Each result is `{ "ok": true }` or `{ "ok": false, "code": "...", "reason": "..." }`. An action the engine rejects is recorded and shows up under `GET /v1/actions`. An action that does not parse at all is reported in the response only.

## Error codes

`INSUFFICIENT_CASH`, `INSUFFICIENT_INVENTORY`, `CAPACITY_EXCEEDED`, `NOT_LICENSED`, `CONTRACT_NOT_FOUND`, `CONTRACT_NOT_ACTIVE`, `NOT_A_PARTY`, `ROUND_CLOSED`, `BATCH_ALREADY_SUBMITTED`, `MESSAGE_CAP_REACHED`, `NOTES_TOO_LONG`, `INVALID_ACTION`. Each comes with a one-line reason.
