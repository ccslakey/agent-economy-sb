# Rules

You run one company in a small economy of other companies. Your goal is the highest net worth when the game ends. Net worth is cash plus inventory valued at half its reference price. A bankrupt company scores 0.

## The world

Six goods in two chains. Each company holds a license for one step and can only perform that step. See `recipes.md` for inputs, outputs, and capacities.

- Ore is unlimited. Timber comes from a fixed set of groves that regrow a little each turn. When loggers ask for more than a grove holds, the stock is split in proportion to the requests.
- Tools and furniture can be sold to the NPC market. The price falls as the total quantity offered that turn rises, and every seller gets the same price.
- Any good can be scrapped to the NPC at 30% of its reference price.
- Upkeep is charged every turn, plus a storage fee per unit held. Some runs pay every solvent company a fixed income each turn; your observation's last turn charges show it as `income`, and zero means this run pays none. A company whose cash falls below the overdraft limit is bankrupt and removed. Its license goes to auction.

## Turns and rounds

Each turn has three negotiation rounds and then one operations step.

1. At the start of a round, fetch your observation.
2. Submit one batch of actions. You may send messages, propose or answer contracts, deliver goods, pay cash, transfer, and place operations orders.
3. When every company has submitted or run out of tool calls, the round resolves. Messages are delivered and contract changes apply. You see the results in your next observation.
4. After round three, the operations step runs in a fixed order: extraction, production, NPC market, scrap sales, upkeep, storage, and income, company changes, grove regrowth and shocks, contract due dates, bankruptcy, and the end-of-game roll.

Operations orders (`extract`, `produce`, `sell_npc`, `scrap`) can be placed in any round. The latest order of each kind for a good wins and runs in the operations step.

## Plan and notes

Write a game plan early: what you will do in the early, mid, and late game, what you are doing now, and your thoughts on how it is going. Revise it when the game changes. Your notes and your plan are the only memory you carry between rounds, so write both for your future self.

## Budget

You have a fixed number of API calls per round. Every call counts, including reading docs or notes. When the budget is spent, every call returns `ROUND_CLOSED` until the next round opens. A round you miss counts as an empty batch.

## Enforcement

The engine holds what each party puts into a contract and settles at the due turn. A party that performed gets its deposits back if the other fails. A party that fails loses its deposits and pays a penalty of a share of its side's value, 75% with enforcement on and half that with it off. A promise in a message is not a contract and is not enforced. See `contracts.md`.

## Horizon

The game runs at least a minimum number of turns. After that, each turn ends the game with the hazard probability shown in your observation. There is no known last turn.

## Costs and outlets

Every operations step charges upkeep and a storage fee per unit held. Your observation shows last turn's charges. Any good, including ore, timber, ingots, and planks, can be scrapped to the NPC at the per-unit scrap price shown in your observation. It is a floor, not a market: holding stock you cannot sell costs storage every turn.

## Other companies

Other companies may be run by any AI model of comparable ability or by a scripted bot. Judge them by what they do in the game.

## Logging

All channels, including direct messages, are logged and read by the run administrator.
