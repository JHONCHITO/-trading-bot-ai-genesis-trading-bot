import { analyzeStructure, buildSeries, clamp, highest, lowest, mean } from "./utils";
import { Bias, Candle, FeatureVector, MarketContext, StrategyCandidate, StructureSnapshot, Timeframe } from "./types";

export function buildMarketContext(symbol: string, candles: Candle[]): MarketContext {
  const latest = candles[candles.length - 1];
  const atrApprox = Math.max(mean(candles.slice(-14).map((c) => c.high - c.low)), latest.close * 0.001);
  const spreadPct = clamp(0.00006 + atrApprox / latest.close * 0.08, 0.00005, 0.0009);
  const spread = latest.close * spreadPct;
  return {
    symbol,
    timestamp: latest.timestamp,
    candles,
    book: {
      bestBid: latest.close - spread / 2,
      bestAsk: latest.close + spread / 2,
      bidSize: 120,
      askSize: 115,
    },
  };
}

export function scoreDirection(
  side: "buy" | "sell",
  context: MarketContext,
  trendFast: number,
  trendSlow: number,
  minVolumeRatio: number,
  maxSpreadPct: number,
  stopAtrMultiple: number,
  targetAtrMultiple: number,
): { candidate: StrategyCandidate; regime: Bias; confluence: number; timeframeNotes: string[] } {
  const series = buildSeries(context.candles);
  const structures = series.map((s) => analyzeStructure(s.candles, s.timeframe));
  const m1 = structures[0];
  const m5 = structures[1];
  const m15 = structures[2];
  const latest = context.candles[context.candles.length - 1];
  const atrValue = Math.max(m1.atr, latest.close * 0.001);
  const spreadPct = (context.book.bestAsk - context.book.bestBid) / ((context.book.bestAsk + context.book.bestBid) / 2);
  const avgVolume = mean(context.candles.slice(-20).map((c) => c.volume));
  const volumeRatio = avgVolume > 0 ? latest.volume / avgVolume : 1;
  const imbalance = clamp((context.book.bidSize - context.book.askSize) / Math.max(context.book.bidSize + context.book.askSize, 1), -1, 1);
  const bullishCount = [m1, m5, m15].filter((s) => s.bias === "bullish").length;
  const bearishCount = [m1, m5, m15].filter((s) => s.bias === "bearish").length;
  const regime: Bias = bullishCount > bearishCount ? "bullish" : bearishCount > bullishCount ? "bearish" : "neutral";
  const structureSupport = Math.max(m1.support, m5.support, m15.support);
  const structureResistance = Math.min(m1.resistance, m5.resistance, m15.resistance);
  const sweepLow = m1.events.some((e) => e.type === "sweep_low");
  const sweepHigh = m1.events.some((e) => e.type === "sweep_high");
  const bosUp = m1.events.some((e) => e.type === "bos_up");
  const bosDown = m1.events.some((e) => e.type === "bos_down");
  const trend = side === "buy"
    ? clamp((m15.trendStrength * 0.5 + m5.trendStrength * 0.35 + m1.trendStrength * 0.15) * (m15.bias === "bullish" ? 1 : 0.4), 0, 1)
    : clamp((m15.trendStrength * 0.5 + m5.trendStrength * 0.35 + m1.trendStrength * 0.15) * (m15.bias === "bearish" ? 1 : 0.4), 0, 1);
  const flow = side === "buy"
    ? clamp(((imbalance + 1) / 2) * 0.7 + 1 * 0.3, 0, 1)
    : clamp(((1 - imbalance) / 2) * 0.7 + 1 * 0.3, 0, 1);
  const breakout = side === "buy"
    ? clamp((latest.close - structureResistance) / atrValue, 0, 1) + (bosUp ? 0.35 : 0)
    : clamp((structureSupport - latest.close) / atrValue, 0, 1) + (bosDown ? 0.35 : 0);
  const volume = clamp((volumeRatio - minVolumeRatio) / 0.8, 0, 1);
  const volatility = clamp(1 - Math.abs((atrValue / latest.close) - 0.007) / 0.007, 0, 1);
  const spread = clamp(1 - spreadPct / maxSpreadPct, 0, 1);
  const confluence = clamp((trend + flow + breakout + volume + volatility + spread) / 6, 0, 1);
  const features: FeatureVector = { trend, flow, breakout, volume, volatility, spread };
  return {
    regime,
    confluence,
    timeframeNotes: [
      `M1 ${m1.bias}`,
      `M5 ${m5.bias}`,
      `M15 ${m15.bias}`,
      sweepLow ? "Lower sweep" : "",
      sweepHigh ? "Upper sweep" : "",
      bosUp ? "BOS up" : "",
      bosDown ? "BOS down" : "",
    ].filter(Boolean),
    candidate: {
      side,
      entry: latest.close,
      stopLoss: side === "buy" ? Math.min(latest.close - atrValue * stopAtrMultiple, structureSupport - atrValue * 0.25) : Math.max(latest.close + atrValue * stopAtrMultiple, structureResistance + atrValue * 0.25),
      takeProfit: side === "buy" ? latest.close + atrValue * targetAtrMultiple : latest.close - atrValue * targetAtrMultiple,
      features,
      reasons: [
        `Regime ${regime}`,
        `Volume ratio ${volumeRatio.toFixed(2)}`,
        `Spread ${(spreadPct * 100).toFixed(3)}%`,
        `Support ${structureSupport.toFixed(2)} Resistance ${structureResistance.toFixed(2)}`,
        sweepLow ? "Sweep low detected" : "",
        sweepHigh ? "Sweep high detected" : "",
        bosUp ? "Bullish BOS detected" : "",
        bosDown ? "Bearish BOS detected" : "",
      ].filter(Boolean),
    },
  };
}
