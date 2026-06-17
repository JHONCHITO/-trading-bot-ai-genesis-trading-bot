function buildExitLevels(signal, model, settings) {
  const entry = signal.features.lastClose;
  const riskDistance = entry * 0.01 * settings.risk.riskMultiplier;

  if (signal.side === 'buy') {
    return {
      entry,
      stopLoss: entry - riskDistance,
      takeProfit: entry + (riskDistance * 1.5)
    };
  }

  return {
    entry,
    stopLoss: entry + riskDistance,
    takeProfit: entry - (riskDistance * 1.5)
  };
}

function toMT5OrderPayload(signal, model, settings) {
  const levels = buildExitLevels(signal, model, settings);

  return {
    generatedAt: new Date().toISOString(),
    symbol: signal.symbol,
    side: signal.action === 'BUY' ? 'buy' : signal.action === 'SELL' ? 'sell' : signal.side,
    action: signal.action,
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    takeProfit: levels.takeProfit,
    confidence: signal.confidence,
    confluenceScore: signal.confluenceScore,
    regime: signal.side === 'buy' ? 'bullish' : 'bearish',
    timeframeNotes: signal.timeframeNotes,
    reasons: signal.reasons,
    riskOk: signal.riskOk,
    state: signal.state,
    modelScore: signal.modelScore,
    features: signal.features
  };
}

module.exports = { toMT5OrderPayload };