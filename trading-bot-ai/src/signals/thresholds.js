function getThresholdState(modelScore, confidence, settings, side) {
  const minConfidence = settings.thresholds.minConfidence;
  const watch = settings.thresholds.watch;
  const ready = settings.thresholds.ready;
  const execute = settings.thresholds.execute;

  let state = 'HOLD';
  let action = 'HOLD';

  if (modelScore >= watch && confidence >= minConfidence) {
    state = 'WATCH';
  }

  if (modelScore >= ready && confidence >= minConfidence) {
    state = side === 'buy' ? 'READY_BUY' : 'READY_SELL';
  }

  if (modelScore >= execute && confidence >= minConfidence) {
    action = side.toUpperCase();
  }

  return { state, action };
}

module.exports = { getThresholdState };