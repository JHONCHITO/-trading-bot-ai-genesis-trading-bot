function avg(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function buildFeatures(market) {
  const bars = market.bars || [];
  const closes = bars.map(b => Number(b.close || 0));
  const highs = bars.map(b => Number(b.high || 0));
  const lows = bars.map(b => Number(b.low || 0));
  const volumes = bars.map(b => Number(b.volume || 0));

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2] || last;

  const trendRaw = prev.close ? (last.close - prev.close) / Math.abs(prev.close) : 0;
  const trend = clamp01(0.5 + trendRaw * 500);

  const volumeAvg = avg(volumes);
  const volume = volumeAvg ? clamp01((last.volume || 0) / volumeAvg) : 0;

  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const range = Math.max(0.0001, recentHigh - recentLow);

  const breakout = clamp01((last.close - recentLow) / range);
  const flow = clamp01((last.close - last.low) / Math.max(0.0001, last.high - last.low));
  const volatility = clamp01(((last.high - last.low) / Math.max(0.0001, last.close)) * 100);
  const spread = clamp01(0.42);

  return {
    symbol: market.symbol,
    timeframe: market.timeframe,
    generatedAt: Number(market.generatedAt),
    trend,
    flow,
    breakout,
    volume,
    volatility,
    spread,
    barsCount: bars.length,
    lastClose: Number(last.close || 0)
  };
}

module.exports = { buildFeatures };