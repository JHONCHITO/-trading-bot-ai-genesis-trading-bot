import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ModelState,
  Signal,
  SignalPackage,
  StrategyCandidate,
  TradeRecord,
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
): { confidence: number; modelScore: number } {
  const modelScore = clamp(dot(state.weights, candidate.features), 0, 1);

  const confidence = clamp(
    modelScore * 0.94 +
      candidate.features.trend * 0.04 +
      candidate.features.flow * 0.02,
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
      this.model.threshold +
        (trade.pnl >= 0 ? -0.002 : 0.004) *
          trade.confidence,
      0.55,
      0.8,
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
    this.model.updatedAt = new Date().toISOString();
  }
}

export async function loadModelState(
  path: string,
  fallback: ModelState,
): Promise<ModelState> {
  try {
    return JSON.parse(
      await readFile(path, "utf8"),
    ) as ModelState;
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