# Recipes

| Role | Action | Inputs | Output | Capacity per turn |
| --- | --- | --- | --- | --- |
| miner | extract | none | 1 ore | 12 ore |
| logger | extract | grove stock | 1 timber | 8 timber |
| smelter | produce | 2 ore | 1 ingot | 6 ingots |
| mill | produce | 1 timber | 1 plank | 6 planks |
| toolmaker | produce | 2 ingots | 1 tool | 3 tools |
| furniture_maker | produce | 3 planks + 1 tool | 1 furniture | 2 furniture |

Production uses the inventory you hold after round three. If you lack inputs for the full order, you produce as many units as the inputs allow.

Reference prices: ore 15, timber 20, ingot 45, plank 30, tool 140, furniture 400. Scrap pays 30% of reference. End-of-game inventory counts at 50% of reference.

A company may buy one extra license with `buy_license` to add a second role, and may bid on the license of a bankrupt company with `bid_license` during the turn after the bankruptcy.
