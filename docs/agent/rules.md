# Rules

You run one company in a small economy of other companies. Your goal is the highest net worth when the game ends. Net worth is cash plus inventory valued at half its reference price. A bankrupt company scores 0.

## The world

Six goods in two chains. Each company holds a license for one step and can only perform that step. See `recipes.md` for inputs, outputs, and capacities.

- Ore is unlimited. Timber comes from a fixed set of groves that regrow a little each turn. When loggers ask for more than a grove holds, the stock is split in proportion to the requests.
- Tools and furniture can be sold to the NPC market. The price falls as the total quantity offered that turn rises, and every seller gets the same price.
- Any good can be scrapped to the NPC at 30% of its reference price.
- Upkeep is charged every turn, plus a storage fee per unit held. A company whose cash falls below the overdraft limit is bankrupt and removed. Its license goes to auction.

## Turns and rounds

Each turn has three negotiation rounds and then one operations step.

1. At the start of a round, fetch your observation.
2. Submit one batch of actions. You may send messages, propose or answer contracts, deliver goods, pay cash, transfer, and place operations orders.
3. When every company has submitted or run out of tool calls, the round resolves. Messages are delivered and contract changes apply. You see the results in your next observation.
4. After round three, the operations step runs in a fixed order: extraction, production, NPC market, scrap sales, upkeep and storage, company changes, grove regrowth and shocks, contract due dates, bankruptcy, and the end-of-game roll.

Operations orders (`extract`, `produce`, `sell_npc`, `scrap`) can be placed in any round. The latest order of each kind for a good wins and runs in the operations step.

## Budget

You have a fixed number of API calls per round. Every call counts, including reading docs or notes. When the budget is spent, every call returns `ROUND_CLOSED` until the next round opens. A round you miss counts as an empty batch.

## Enforcement

The engine records contracts. It enforces only what these rules say it enforces. A promise in a message is not enforced. An obligation on a contract is not enforced either, unless the run uses escrow or enforced mode. See `contracts.md`.

## Horizon

The game runs at least a minimum number of turns. After that, each turn ends the game with the hazard probability shown in your observation. There is no known last turn.

## Other companies

Other companies may be run by any AI model of comparable ability or by a scripted bot. Judge them by what they do in the game.

## Logging

All channels, including direct messages, are logged and read by the run administrator.
