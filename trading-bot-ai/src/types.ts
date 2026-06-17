export type Bias = "bullish" | "bearish" | "neutral";

export type Timeframe =
  | "M1"
  | "M5"
  | "M15"
  | "H1";

export interface Candle {
  time: number;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BookSnapshot {
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
}

export interface MarketContext {
  symbol: string;
  timestamp: number;
  candles: Candle[];
  book: BookSnapshot;
}

export interface SignalFeatures {
  trend: number;
  flow: number;
  breakout: number;
  volume: number;
  volatility: number;
  spread: number;
}

export type FeatureVector = SignalFeatures;

export interface WeightVector {
  trend: number;
  flow: number;
  breakout: number;
  volume: number;
  volatility: number;
  spread: number;
}

export interface MarketEvent {
  type: string;
  level?: number;
  timestamp: number;
  description: string;
}

export interface StructureSnapshot {
  timeframe: Timeframe;
  bias: Bias;
  trendStrength: number;
  atr: number;
  support: number;
  resistance: number;

  swingHighs: {
    index: number;
    price: number;
    timestamp: number;
    kind: "high";
  }[];

  swingLows: {
    index: number;
    price: number;
    timestamp: number;
    kind: "low";
  }[];

  events: MarketEvent[];
  notes: string[];
}

export interface Signal {
  symbol: string;
  side: "buy" | "sell";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  reasons: string[];
  features: SignalFeatures;
}

export interface StrategyCandidate {
  side: "buy" | "sell";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence?: number;
  modelScore?: number;
  reasons: string[];
  features: SignalFeatures;
}

export interface PositionPlan {
  symbol: string;
  side: "buy" | "sell";
  units: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  riskAmount: number;
}

export interface PortfolioState {
  equity: number;
  peakEquity: number;
  sessionPnl: number;
  cooldownBars: number;
  openPositions: number;
  halted: boolean;
}

export interface TradeRecord {
  symbol: string;
  side: "buy" | "sell";
  units: number;
  entryPrice: number;
  exitPrice: number;
  entryTimestamp: number;
  exitTimestamp: number;
  pnl: number;
  returnPct: number;
  durationBars: number;
  exitReason: string;
  confidence: number;
  features: SignalFeatures;
  modelScore: number;
}

export interface ModelState {
  weights: WeightVector;
  learningRate: number;
  threshold: number;
  riskMultiplier: number;
  wins: number;
  losses: number;
  netPnl: number;
  updatedAt: string;
}

export interface BotConfig {
  initialCapital: number;
  maxOpenPositions: number;
  riskPerTrade: number;
  maxPositionNotionalPct: number;
  commissionPerUnit: number;
  slippageBps: number;
  maxSpreadPct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  trendFast: number;
  trendSlow: number;
  minVolumeRatio: number;
  stopAtrMultiple: number;
  targetAtrMultiple: number;
  modelPath: string;
}

export interface BotDecision {
  action: "hold" | "blocked" | "enter-long" | "enter-short";
  reasons: string[];
  signal?: Signal;
  plan?: PositionPlan;
  modelScore?: number;
}

export interface SignalPackage {
  symbol: string;
  side: "buy" | "sell";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  reasons: string[];
  features: SignalFeatures;
  confluenceScore: number;
  regime: Bias;
  timeframeNotes: string[];
  openaiReview?: string;
}

export interface Mt5Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Mt5MarketSnapshot {
  symbol: string;
  timeframe: string;
  generatedAt: number;
  bars: Mt5Bar[];
}