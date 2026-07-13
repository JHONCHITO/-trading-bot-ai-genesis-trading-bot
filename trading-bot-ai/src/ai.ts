import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MarketMemory,
  ModelState,
  Signal,
  SignalPackage,
  StrategyCandidate,
  TradeRecord,
  TradeStats,
  WeightVector,
} from "./types";
import { clamp } from "./utils";

type FeatureVector = {
  trend: number;
  flow: number;
  breakout: number;
  volume: number;
  volatility: number;
  spread: number;
};

function createTradeStats(): TradeStats {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    avgConfidence: 0,
  };
}

function createMarketMemory(): MarketMemory {
  return {
    updatedAt: new Date().toISOString(),
    totalTrades: 0,
    totalWins: 0,
    totalLosses: 0,
    totalPnl: 0,
    bySide: {
      buy: createTradeStats(),
      sell: createTradeStats(),
    },
    byHour: {},
    recentOutcomes: [],
  };
}

function ensureMemory(state: ModelState): MarketMemory {
  if (!state.memory) {
    state.memory = createMarketMemory();
  }

  state.memory.bySide.buy ??= createTradeStats();
  state.memory.bySide.sell ??= createTradeStats();
  state.memory.byHour ??= {};
  state.memory.recentOutcomes ??= [];
  state.memory.recentOutcomes = state.memory.recentOutcomes.slice(-120);

  return state.memory;
}

function updateStats(stats: TradeStats, trade: TradeRecord): TradeStats {
  const trades = stats.trades + 1;
  const wins = stats.wins + (trade.pnl >= 0 ? 1 : 0);
  const losses = stats.losses + (trade.pnl < 0 ? 1 : 0);
  const pnl = stats.pnl + trade.pnl;
  const avgConfidence = stats.avgConfidence + (trade.confidence - stats.avgConfidence) / trades;

  return {
    trades,
    wins,
    losses,
    pnl,
    avgConfidence,
  };
}

function edgeFromStats(stats?: TradeStats): number {
  if (!stats || stats.trades < 5) return 0;

  const winRate = stats.wins / stats.trades;
  const pnlPerTrade = stats.pnl / stats.trades;
  const confidenceBias = clamp((stats.avgConfidence - 0.5) * 0.15, -0.05, 0.05);
  return clamp((winRate - 0.5) * 0.2 + Math.tanh(pnlPerTrade / 1000) * 0.08 + confidenceBias, -0.12, 0.12);
}

function deriveMemoryMultiplier(state: ModelState, side: "buy" | "sell", hour?: number): number {
  const memory = ensureMemory(state);
  const sideStats = memory.bySide[side];
  const totalTrades = memory.totalTrades || 0;
  const overallWinRate = totalTrades > 0 ? memory.totalWins / totalTrades : 0.5;
  const sideEdge = edgeFromStats(sideStats);
  const overallEdge = clamp((overallWinRate - 0.5) * 0.08, -0.04, 0.04);
  const hourStats = hour === undefined ? undefined : memory.byHour[hour.toString()];
  const hourEdge = edgeFromStats(hourStats);
  return clamp(1 + sideEdge + overallEdge + hourEdge * 0.75, 0.88, 1.12);
}

function dot(w: WeightVector, f: FeatureVector): number {
  return (
    w.trend * f.trend +
    w.flow * f.flow +
    w.breakout * f.breakout +
    w.volume * f.volume +
    w.volatility * f.volatility +
    w.spread * f.spread
  );
}

function normalize(weights: WeightVector): WeightVector {
  const sum =
    weights.trend +
    weights.flow +
    weights.breakout +
    weights.volume +
    weights.volatility +
    weights.spread;

  const floor = 0.04;

  const raw = {
    trend: Math.max(weights.trend / sum, floor),
    flow: Math.max(weights.flow / sum, floor),
    breakout: Math.max(weights.breakout / sum, floor),
    volume: Math.max(weights.volume / sum, floor),
    volatility: Math.max(weights.volatility / sum, floor),
    spread: Math.max(weights.spread / sum, floor),
  };

  const s =
    raw.trend +
    raw.flow +
    raw.breakout +
    raw.volume +
    raw.volatility +
    raw.spread;

  return {
    trend: raw.trend / s,
    flow: raw.flow / s,
    breakout: raw.breakout / s,
    volume: raw.volume / s,
    volatility: raw.volatility / s,
    spread: raw.spread / s,
  };
}

export function scoreCandidate(
  state: ModelState,
  candidate: StrategyCandidate,
  hour?: number,
): { confidence: number; modelScore: number } {
  const memoryMultiplier = deriveMemoryMultiplier(state, candidate.side, hour);
  const modelScore = clamp(dot(state.weights, candidate.features) * memoryMultiplier, 0, 1);

  const confidence = clamp(
    modelScore * 0.92 +
      candidate.features.trend * 0.04 +
      candidate.features.flow * 0.02 +
      Math.max(0, memoryMultiplier - 1) * 0.08,
    0,
    1,
  );

  return { confidence, modelScore };
}

export class AdaptiveCoach {
  constructor(private readonly model: ModelState) {}

  getState(): ModelState {
    return this.model;
  }

  select(snapshot: {
    candidates: StrategyCandidate[];
    diagnostics: string[];
    timestamp?: number;
  }): {
    signal: Signal | null;
    diagnostics: string[];
    modelScore: number;
  } {
    const diagnostics = [...snapshot.diagnostics];

    let best: (Signal & { modelScore: number }) | null = null;

    for (const candidate of snapshot.candidates) {
      const { confidence, modelScore } = scoreCandidate(
        this.model,
        candidate,
        snapshot.timestamp ? new Date(snapshot.timestamp).getHours() : undefined,
      );

      diagnostics.push(
        `${candidate.side.toUpperCase()} score=${modelScore.toFixed(
          3,
        )} conf=${confidence.toFixed(
          3,
        )} thr=${this.model.threshold.toFixed(3)}`,
      );

      if (confidence < this.model.threshold) continue;

      const enriched = {
        ...candidate,
        confidence,
        modelScore,
      };

      if (!best || enriched.confidence > best.confidence) {
        best = enriched as Signal & { modelScore: number };
      }
    }

    if (!best) {
      return {
        signal: null,
        diagnostics: [...diagnostics, "No valid candidate"],
        modelScore: 0,
      };
    }

    diagnostics.push(
      `Selected ${best.side.toUpperCase()} with model score ${best.modelScore.toFixed(
        3,
      )}`,
    );

    return {
      signal: best,
      diagnostics,
      modelScore: best.modelScore,
    };
  }

  learn(trade: TradeRecord): void {
    const memory = ensureMemory(this.model);
    const direction = trade.pnl >= 0 ? 1 : -1;

    const lr =
      this.model.learningRate *
      (trade.confidence * 0.75 + 0.25);

    const drift =
      trade.pnl /
      Math.max(
        Math.abs(trade.entryPrice * trade.units),
        1,
      );

    const updated: WeightVector = {
      trend:
        this.model.weights.trend +
        lr * direction * (trade.features.trend - 0.5) +
        drift * 0.03,

      flow:
        this.model.weights.flow +
        lr * direction * (trade.features.flow - 0.5) +
        drift * 0.03,

      breakout:
        this.model.weights.breakout +
        lr * direction * (trade.features.breakout - 0.5) +
        drift * 0.03,

      volume:
        this.model.weights.volume +
        lr * direction * (trade.features.volume - 0.5) +
        drift * 0.02,

      volatility:
        this.model.weights.volatility +
        lr * direction * (trade.features.volatility - 0.5) +
        drift * 0.015,

      spread:
        this.model.weights.spread +
        lr * direction * (trade.features.spread - 0.5) +
        drift * 0.01,
    };

    this.model.weights = normalize(updated);

    this.model.threshold = clamp(
      this.model.threshold + (trade.pnl >= 0 ? -0.002 : 0.004) * trade.confidence,
      0.42,
      0.75,
    );

    this.model.riskMultiplier = clamp(
      this.model.riskMultiplier +
        (trade.pnl >= 0 ? 0.008 : -0.012),
      0.65,
      1.2,
    );

    this.model.wins += trade.pnl >= 0 ? 1 : 0;
    this.model.losses += trade.pnl < 0 ? 1 : 0;
    this.model.netPnl += trade.pnl;
    memory.totalTrades += 1;
    memory.totalWins += trade.pnl >= 0 ? 1 : 0;
    memory.totalLosses += trade.pnl < 0 ? 1 : 0;
    memory.totalPnl += trade.pnl;
    memory.bySide[trade.side] = updateStats(memory.bySide[trade.side], trade);

    const hourKey = new Date(trade.exitTimestamp).getHours().toString();
    memory.byHour[hourKey] = updateStats(memory.byHour[hourKey] ?? createTradeStats(), trade);

    memory.recentOutcomes.push({
      pnl: trade.pnl,
      confidence: trade.confidence,
      side: trade.side,
      timestamp: trade.exitTimestamp,
    });
    memory.recentOutcomes = memory.recentOutcomes.slice(-120);
    memory.updatedAt = new Date().toISOString();
    this.model.updatedAt = new Date().toISOString();
  }
}

export async function loadModelState(
  path: string,
  fallback: ModelState,
): Promise<ModelState> {
  try {
    const loaded = JSON.parse(
      await readFile(path, "utf8"),
    ) as ModelState;
    return {
      ...fallback,
      ...loaded,
      memory: loaded.memory ?? fallback.memory,
      weights: loaded.weights ?? fallback.weights,
    };
  } catch {
    return fallback;
  }
}

export async function saveModelState(
  path: string,
  state: ModelState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  await writeFile(
    path,
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

export async function appendTradeJournal(
  path: string,
  trade: TradeRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  await appendFile(
    path,
    `${JSON.stringify(trade)}\n`,
    "utf8",
  );
}

export function createSignalPackage(
  _symbol: string,
  signal: Signal,
  regime: "bullish" | "bearish" | "neutral",
  confluenceScore: number,
  timeframeNotes: string[],
): SignalPackage {
  return {
    ...signal,
    regime,
    confluenceScore,
    timeframeNotes,
  };
}

export function cloneModelState(state: ModelState): ModelState {
  return JSON.parse(JSON.stringify(state)) as ModelState;
}
