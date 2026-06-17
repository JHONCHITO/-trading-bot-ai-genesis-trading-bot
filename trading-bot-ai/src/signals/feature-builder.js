function avg(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function ema(closes, period) {
  const k = 2 / (period + 1);
  let e = closes[0];
  for (let i = 1; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function buildFeatures(market) {
  const bars = market.bars || [];
  const closes = bars.map(b => Number(b.close || 0));
  const highs  = bars.map(b => Number(b.high  || 0));
  const lows   = bars.map(b => Number(b.low   || 0));
  const volumes = bars.map(b => Number(b.volume || 0));

  const last = bars[bars.length - 1];
  const n = bars.length;

  // TREND: EMA20 vs EMA50 (señal real de tendencia)
  const emaFast = ema(closes, 20);
  const emaSlow = ema(closes, 50);
  const atr = avg(bars.slice(-14).map((b, i, arr) => {
    if (i === 0) return Number(b.high) - Number(b.low);
    return Math.max(
      Number(b.high) - Number(b.low),
      Math.abs(Number(b.high) - Number(arr[i-1].close)),
      Math.abs(Number(b.low)  - Number(arr[i-1].close))
    );
  }));
  const trendDiff = (emaFast - emaSlow) / Math.max(atr, 0.0001);
  const trend = clamp01(0.5 + trendDiff * 0.15);

  // BREAKOUT: rango de últimas 20 velas (no 240)
  const lookback = 20;
  const recentBars = bars.slice(-lookback);
  const recentHigh = Math.max(...recentBars.map(b => Number(b.high)));
  const recentLow  = Math.min(...recentBars.map(b => Number(b.low)));
  const range = Math.max(0.0001, recentHigh - recentLow);
  const breakout = clamp01((Number(last.close) - recentLow) / range);

  // FLOW: vela actual (sin cambios, estaba bien)
  const flow = clamp01(
    (Number(last.close) - Number(last.low)) /
    Math.max(0.0001, Number(last.high) - Number(last.low))
  );

  // VOLUME: volumen actual vs promedio últimas 20 velas
  const volAvg = avg(volumes.slice(-20));
  const volume = volAvg ? clamp01(Number(last.volume || 0) / volAvg / 2) : 0.5;

  // VOLATILITY: sin cambios
  const volatility = clamp01(
    ((Number(last.high) - Number(last.low)) / Math.max(0.0001, Number(last.close))) * 100
  );

  // SPREAD: real desde market.analysis
  const spreadPct = market.analysis?.spreadPoints
    ? clamp01(market.analysis.spreadPoints / 50)
    : 0.1;
  const spread = spreadPct;

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
    barsCount: n,
    lastClose: Number(last.close || 0)
  };
}

module.exports = { buildFeatures };