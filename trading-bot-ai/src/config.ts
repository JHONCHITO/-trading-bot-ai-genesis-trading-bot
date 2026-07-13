import { BotConfig, ModelState } from "./types";

export const DEFAULT_CONFIG: BotConfig = {
  initialCapital: 10000,
  symbol: "US30",
  maxOpenPositions: 1,

  riskPerTrade: 0.02,
  maxPositionNotionalPct: 1.0,
  commissionPerUnit: 0.01,
  slippageBps: 1,

  maxSpreadPct: 0.008,
  maxDailyLossPct: 0.02,
  maxDrawdownPct: 0.10,
  sessionStartHour: 0,
  sessionEndHour: 23,

  atrLookback: 14,
  cooldownBarsAfterLoss: 3,

  trendFast: 20,
  trendSlow: 50,

  minVolumeRatio: 1.0,
  stopAtrMultiple: 1.5,
  targetAtrMultiple: 2.0,

  newsPath: "./state/news.json",
  journalPath: "./state/journal.jsonl",
  modelPath: "./state/model.json"
};

export function createInitialModelState(config: BotConfig): ModelState {
  return {
    learningRate: 0.05,

    weights: {
      trend: 0.26,
      flow: 0.22,
      breakout: 0.20,
      volume: 0.12,
      volatility: 0.12,
      spread: 0.08
    },

    threshold: 0.47,
    riskMultiplier: 1.12,
    wins: 0,
    losses: 0,
    netPnl: 0,
    memory: {
      updatedAt: new Date().toISOString(),
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
      totalPnl: 0,
      bySide: {
        buy: {
          trades: 0,
          wins: 0,
          losses: 0,
          pnl: 0,
          avgConfidence: 0,
        },
        sell: {
          trades: 0,
          wins: 0,
          losses: 0,
          pnl: 0,
          avgConfidence: 0,
        },
      },
      byHour: {},
      recentOutcomes: [],
    },
    updatedAt: new Date().toISOString()
  };
}
