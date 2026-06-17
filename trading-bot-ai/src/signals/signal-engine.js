const { getThresholdState } = require('./thresholds');

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function evaluateSignal(features, model, settings) {
  const w = model.weights;

  const modelScore = clamp01(
    (features.trend * w.trend) +
    (features.flow * w.flow) +
    (features.breakout * w.breakout) +
    (features.volume * w.volume) +
    (features.volatility * w.volatility) +
    ((1 - features.spread) * w.spread)
  );

  const confidence = clamp01((modelScore * 0.7) + (features.breakout * 0.3));
  const side = features.trend >= 0.5 ? 'buy' : 'sell';
  const thresholdDecision = getThresholdState(modelScore, confidence, settings, side);

  return {
    symbol: features.symbol,
    timeframe: features.timeframe,
    generatedAt: features.generatedAt,
    state: thresholdDecision.state,
    action: thresholdDecision.action,
    side,
    modelScore: Number(modelScore.toFixed(6)),
    confidence: Number(confidence.toFixed(6)),
    confluenceScore: Number(modelScore.toFixed(6)),
    features,
    timeframeNotes: [
      'Market structure ready',
      `Base candles: ${features.barsCount}`,
      `${side.toUpperCase()} score=${modelScore.toFixed(3)} conf=${confidence.toFixed(3)} thr=${settings.thresholds.execute.toFixed(3)}`
    ],
    reasons: []
  };
}

module.exports = { evaluateSignal };