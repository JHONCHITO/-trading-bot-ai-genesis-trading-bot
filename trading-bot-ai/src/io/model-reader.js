const { readJsonSafe } = require('../utils/file');

function readModel(settings) {
  const result = readJsonSafe(settings.io.modelFile);

  if (!result.ok) {
    return {
      ok: false,
      reason: ['model_file_read_failed', result.error]
    };
  }

  const model = result.data || {};
  const weights = model.weights || {};

  const requiredWeights = ['trend', 'flow', 'breakout', 'volume', 'volatility', 'spread'];
  const missing = requiredWeights.filter((key) => typeof weights[key] !== 'number');

  if (typeof model.threshold !== 'number') {
    missing.push('threshold');
  }

  if (missing.length) {
    return {
      ok: false,
      reason: ['invalid_model_file', ...missing]
    };
  }

  return { ok: true, model };
}

module.exports = { readModel };