export { BOTS, type Bot, type BotMemory, type BotView, freshMemory } from './bots.ts';
export { buildMcpServer, GameClient, type GameClientOptions } from './mcp.ts';
export {
  byStrategy,
  type CompanySummary,
  type PlayResult,
  playBots,
  roster,
  type StrategyStats,
  type Summary,
  summarize,
} from './play.ts';
