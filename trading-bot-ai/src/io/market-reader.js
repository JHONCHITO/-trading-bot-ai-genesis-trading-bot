const { readJsonSafe } = require('../utils/file');

function readMarket(settings) {
  const result = readJsonSafe(settings.io.marketFile);

  if (!result.ok) {
    return {
      ok: false,
      state: 'ERROR_DATA',
      action: 'HOLD',
      reason: ['market_file_read_failed', result.error]
    };
  }

  const market = result.data;
  const reasons = [];

  if (!market.symbol) reasons.push('missing_symbol');
  if (!market.timeframe) reasons.push('missing_timeframe');
  if (!market.generatedAt) reasons.push('missing_generatedAt');
  if (!Array.isArray(market.bars)) reasons.push('missing_bars');
  if (Array.isArray(market.bars) && market.bars.length < settings.market.minBarsContext) {
    reasons.push('insufficient_bars');
  }

  if (reasons.length) {
    return {
      ok: false,
      state: 'ERROR_DATA',
      action: 'HOLD',
      reason: reasons
    };
  }

  return { ok: true, market };
}

module.exports = { readMarket };