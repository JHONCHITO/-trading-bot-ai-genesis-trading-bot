const { readJsonSafe, writeJson } = require('../utils/file');

function getDefaultRuntime() {
  return {
    lastProcessedGeneratedAt: 0,
    tradesToday: 0,
    blockedToday: 0,
    holdsToday: 0,
    errorsToday: 0,
    lastTradeAt: 0
  };
}

function loadRuntime(settings) {
  const result = readJsonSafe(settings.io.runtimeFile);

  if (!result.ok) {
    return getDefaultRuntime();
  }

  return {
    lastProcessedGeneratedAt: Number(result.data.lastProcessedGeneratedAt || 0),
    tradesToday: Number(result.data.tradesToday || 0),
    blockedToday: Number(result.data.blockedToday || 0),
    holdsToday: Number(result.data.holdsToday || 0),
    errorsToday: Number(result.data.errorsToday || 0),
    lastTradeAt: Number(result.data.lastTradeAt || 0)
  };
}

function saveRuntime(settings, runtime) {
  writeJson(settings.io.runtimeFile, runtime);
}

module.exports = {
  getDefaultRuntime,
  loadRuntime,
  saveRuntime
};