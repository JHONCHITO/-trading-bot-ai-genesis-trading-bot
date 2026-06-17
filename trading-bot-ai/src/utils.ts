import { Candle, MarketEvent, StructureSnapshot, Timeframe } from "./types";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i += 1) result = values[i] * k + result * (1 - k);
  return result;
}

export function atr(candles: Candle[], period: number): number {
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - period);
  const ranges: number[] = [];
  for (let i = start; i < candles.length; i += 1) {
    const cur = candles[i];
    const prev = candles[i - 1];
    ranges.push(
      Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      ),
    );
  }
  return mean(ranges);
}

export function highest(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}

export function lowest(values: number[]): number {
  return values.length ? Math.min(...values) : 0;
}

export function slope(values: number[]): number {
  if (values.length < 2) return 0;
  return (values[values.length - 1] - values[0]) / values.length;
}

export function aggregateCandles(candles: Candle[], size: number): Candle[] {
  if (size <= 1) return candles.slice();
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i += size) {
    const slice = candles.slice(i, i + size);
    if (!slice.length) continue;
    out.push({
      timestamp: slice[slice.length - 1].timestamp,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return out;
}

export function buildSeries(candles: Candle[]): { timeframe: Timeframe; candles: Candle[] }[] {
  return [
    { timeframe: "M1", candles: candles.slice() },
    { timeframe: "M5", candles: aggregateCandles(candles, 5) },
    { timeframe: "M15", candles: aggregateCandles(candles, 15) },
    { timeframe: "H1", candles: aggregateCandles(candles, 60) },
  ];
}

function findSwings(candles: Candle[], strength = 2): { highs: { index: number; price: number; timestamp: number; kind: "high" }[]; lows: { index: number; price: number; timestamp: number; kind: "low" }[] } {
  const highs: { index: number; price: number; timestamp: number; kind: "high" }[] = [];
  const lows: { index: number; price: number; timestamp: number; kind: "low" }[] = [];
  for (let i = strength; i < candles.length - strength; i += 1) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= strength; j += 1) {
      if (candles[i - j].high >= c.high || candles[i + j].high > c.high) isHigh = false;
      if (candles[i - j].low <= c.low || candles[i + j].low < c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: c.high, timestamp: c.timestamp, kind: "high" });
    if (isLow) lows.push({ index: i, price: c.low, timestamp: c.timestamp, kind: "low" });
  }
  return { highs, lows };
}

function biasFromTrend(candles: Candle[], atrValue: number): { bias: "bullish" | "bearish" | "neutral"; trendStrength: number } {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes.slice(-20), 20);
  const slow = ema(closes.slice(-60), 60);
  const strength = clamp(Math.abs(fast - slow) / Math.max(atrValue, closes[closes.length - 1] * 0.001), 0, 2) / 2;
  if (fast > slow && slope(closes.slice(-12)) >= 0) return { bias: "bullish", trendStrength: strength };
  if (fast < slow && slope(closes.slice(-12)) <= 0) return { bias: "bearish", trendStrength: strength };
  return { bias: "neutral", trendStrength: strength * 0.5 };
}

export function analyzeStructure(candles: Candle[], timeframe: Timeframe): StructureSnapshot {
  const latest = candles[candles.length - 1];
  const atrValue = Math.max(atr(candles, Math.min(14, candles.length)), latest.close * 0.001);
  const { highs, lows } = findSwings(candles, 2);
  const { bias, trendStrength } = biasFromTrend(candles, atrValue);
  const support = lows.length ? lows[lows.length - 1].price : lowest(candles.slice(-20).map((c) => c.low));
  const resistance = highs.length ? highs[highs.length - 1].price : highest(candles.slice(-20).map((c) => c.high));
  const prevClose = candles[candles.length - 2]?.close ?? latest.close;
  const recentHigh = highest(candles.slice(-12).map((c) => c.high));
  const recentLow = lowest(candles.slice(-12).map((c) => c.low));
  const events: MarketEvent[] = [];

  if (highs.at(-1) && latest.high > highs.at(-1)!.price && latest.close < highs.at(-1)!.price) {
    events.push({ type: "sweep_high", level: highs.at(-1)!.price, timestamp: latest.timestamp, description: "Upper sweep." });
  }
  if (lows.at(-1) && latest.low < lows.at(-1)!.price && latest.close > lows.at(-1)!.price) {
    events.push({ type: "sweep_low", level: lows.at(-1)!.price, timestamp: latest.timestamp, description: "Lower sweep." });
  }
  if (latest.close > recentHigh && prevClose <= recentHigh) {
    events.push({ type: "bos_up", level: recentHigh, timestamp: latest.timestamp, description: "Bullish BOS." });
  }
  if (latest.close < recentLow && prevClose >= recentLow) {
    events.push({ type: "bos_down", level: recentLow, timestamp: latest.timestamp, description: "Bearish BOS." });
  }
  if (highs.at(-1) && Math.abs(latest.close - highs.at(-1)!.price) / highs.at(-1)!.price < 0.0015) {
    events.push({ type: "retest_up", level: highs.at(-1)!.price, timestamp: latest.timestamp, description: "Retest resistance." });
  }
  if (lows.at(-1) && Math.abs(latest.close - lows.at(-1)!.price) / lows.at(-1)!.price < 0.0015) {
    events.push({ type: "retest_down", level: lows.at(-1)!.price, timestamp: latest.timestamp, description: "Retest support." });
  }

  return {
    timeframe,
    bias,
    trendStrength,
    atr: atrValue,
    support,
    resistance,
    swingHighs: highs.slice(-5),
    swingLows: lows.slice(-5),
    events,
    notes: [
      `Bias ${bias}`,
      `Trend ${trendStrength.toFixed(2)}`,
      `ATR ${atrValue.toFixed(4)}`,
      ...(events.length ? events.map((e) => e.description) : ["No major event"]),
    ],
  };
}
