module.exports = {
  bot: {
    name: 'GENESIS',
    mode: 'paper'
  },
  market: {
    symbol: 'US30',
    timeframeContext: 'H1',
    timeframeTrigger: 'M5',
    minBarsContext: 2,
    maxSpreadPct: 0.80
  },
  thresholds: {
    watch: 0.420,
    ready: 0.460,
    execute: 0.470,
    minConfidence: 0.420
  },
  risk: {
    maxTradesPerSession: 3,
    cooldownSeconds: 900,
    dailyLossLimitPct: 2.0,
    allowLong: true,
    allowShort: true,
    riskMultiplier: 1.12,
    riskPerTrade: 0.01
  },
  account: {
    equity: 10000
  },
  execution: {
    minUnits: 1,
    maxUnits: 100000,
    unitStep: 1,
    pointValue: 1
  },
  io: {
    marketFile: './state/mt5-market.json',
    signalFile: './state/mt5-signal.json',
    modelFile: './state/model.json',
    runtimeFile: './state/runtime-state.json',
    logFile: './state/journal.jsonl'
  }
};