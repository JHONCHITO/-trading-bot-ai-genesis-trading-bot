const settings = require('../config/settings');
const { readMarket } = require('../io/market-reader');
const { readModel } = require('../io/model-reader');
const { loadRuntime, saveRuntime } = require('../io/runtime-reader');
const { buildFeatures } = require('../signals/feature-builder');
const { evaluateSignal } = require('../signals/signal-engine');
const { applyRisk } = require('../risk/risk-manager');
const { toMT5OrderPayload } = require('../execution/mt5-bridge');
const { writeSignal } = require('../io/signal-writer');
const { logEvent } = require('../monitoring/logger');

async function runPipeline() {
  const runtime = loadRuntime(settings);

  const marketResult = readMarket(settings);
  if (!marketResult.ok) {
    runtime.errorsToday += 1;
    saveRuntime(settings, runtime);
    writeSignal(settings, {
      generatedAt: new Date().toISOString(),
      symbol: settings.market.symbol,
      action: 'HOLD',
      state: 'ERROR_DATA',
      reasons: marketResult.reason,
      riskOk: false
    });
    logEvent(settings.io.logFile, 'error', 'market_read_failed', { reasons: marketResult.reason });
    return;
  }

  const modelResult = readModel(settings);
  if (!modelResult.ok) {
    runtime.errorsToday += 1;
    saveRuntime(settings, runtime);
    writeSignal(settings, {
      generatedAt: new Date().toISOString(),
      symbol: settings.market.symbol,
      action: 'HOLD',
      state: 'ERROR_MODEL',
      reasons: modelResult.reason,
      riskOk: false
    });
    logEvent(settings.io.logFile, 'error', 'model_read_failed', { reasons: modelResult.reason });
    return;
  }

  const features = buildFeatures(marketResult.market);
  const rawSignal = evaluateSignal(features, modelResult.model, settings);
  const decision = applyRisk(rawSignal, modelResult.model, runtime, settings);
  const mt5Payload = toMT5OrderPayload(decision, modelResult.model, settings);

  if (decision.action === 'BUY' || decision.action === 'SELL') {
    runtime.tradesToday += 1;
    runtime.lastTradeAt = decision.generatedAt;
  } else if (decision.state === 'BLOCKED_RISK') {
    runtime.blockedToday += 1;
  } else {
    runtime.holdsToday += 1;
  }

  runtime.lastProcessedGeneratedAt = features.generatedAt;
  saveRuntime(settings, runtime);
  writeSignal(settings, mt5Payload);
  logEvent(settings.io.logFile, 'info', 'pipeline_result', mt5Payload);

  return mt5Payload;
}

module.exports = { runPipeline };