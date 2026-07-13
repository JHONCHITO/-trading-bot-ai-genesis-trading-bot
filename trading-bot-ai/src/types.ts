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

export type NewsSeverity = "low" | "medium" | "high" | "critical";

export interface NewsEvent {
  title: string;
  timestamp: number;
  currency?: string;
  symbols?: string[];
  severity: NewsSeverity;
  beforeMinutes: number;
  afterMinutes: number;
  blocked: boolean;
  source?: string;
}

export interface NewsState {
  source: string;
  updatedAt: string;
  blocked: boolean;
  blackoutUntil?: number;
  events: NewsEvent[];
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

export interface JournalEntry {
  ts: number;
  type: "trade" | "decision" | "risk" | "news" | "system" | "error";
  symbol?: string;
  message: string;
  payload?: unknown;
}

export interface BacktestFoldReport {
  fold: number;
  trainBars: number;
  testBars: number;
  trainEquity: number;
  testEquity: number;
  trainNetPnL: number;
  testNetPnL: number;
  trainTrades: number;
  testTrades: number;
  trainWinRate: number;
  testWinRate: number;
  trainProfitFactor: number;
  testProfitFactor: number;
  testSharpeLike: number;
  maxDrawdownPct: number;
}

export interface WalkForwardReport {
  folds: BacktestFoldReport[];
  totalTrades: number;
  averageWinRate: number;
  averageProfitFactor: number;
  averageSharpeLike: number;
  worstDrawdownPct: number;
  finalEquity: number;
  netPnL: number;
}

export interface Position {
  plan: PositionPlan;
  entryFill: {
    symbol: string;
    side: "buy" | "sell";
    units: number;
    price: number;
    commission: number;
    timestamp: number;
  };
  entryIndex: number;
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
  memory: MarketMemory;
  updatedAt: string;
}

export interface TradeStats {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  avgConfidence: number;
}

export interface MarketMemory {
  updatedAt: string;
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  totalPnl: number;
  bySide: {
    buy: TradeStats;
    sell: TradeStats;
  };
  byHour: Record<string, TradeStats>;
  recentOutcomes: {
    pnl: number;
    confidence: number;
    side: "buy" | "sell";
    timestamp: number;
  }[];
}

export interface OpenAIReview {
  enabled: boolean;
  model: string;
  verdict: "approve" | "caution" | "reject";
  confidenceAdjustment: number;
  summary: string;
  keyRisks: string[];
  suggestions: string[];
}

export interface BotConfig {
  initialCapital: number;
  symbol: string;
  maxOpenPositions: number;
  riskPerTrade: number;
  maxPositionNotionalPct: number;
  commissionPerUnit: number;
  slippageBps: number;
  maxSpreadPct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  sessionStartHour: number;
  sessionEndHour: number;
  atrLookback: number;
  trendFast: number;
  trendSlow: number;
  minVolumeRatio: number;
  stopAtrMultiple: number;
  targetAtrMultiple: number;
  cooldownBarsAfterLoss: number;
  newsPath: string;
  journalPath: string;
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
  signalId?: string;
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
  openaiReview?: OpenAIReview;
}

export interface Mt5Bar {
  time: number;
  timestamp?: number;
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
