const { loadRuntime, saveRuntime } = require('../io/runtime-reader');

function getSessionState(settings) {
  return loadRuntime(settings);
}

function setSessionState(settings, runtime) {
  saveRuntime(settings, runtime);
}

function markProcessed(settings, runtime, generatedAt) {
  const next = {
    ...runtime,
    lastProcessedGeneratedAt: Number(generatedAt || 0)
  };

  saveRuntime(settings, next);
  return next;
}

function markTrade(settings, runtime, generatedAt) {
  const next = {
    ...runtime,
    tradesToday: Number(runtime.tradesToday || 0) + 1,
    lastTradeAt: Number(generatedAt || 0),
    lastProcessedGeneratedAt: Number(generatedAt || 0)
  };

  saveRuntime(settings, next);
  return next;
}

function markBlocked(settings, runtime, generatedAt) {
  const next = {
    ...runtime,
    blockedToday: Number(runtime.blockedToday || 0) + 1,
    lastProcessedGeneratedAt: Number(generatedAt || 0)
  };

  saveRuntime(settings, next);
  return next;
}

function markHold(settings, runtime, generatedAt) {
  const next = {
    ...runtime,
    holdsToday: Number(runtime.holdsToday || 0) + 1,
    lastProcessedGeneratedAt: Number(generatedAt || 0)
  };

  saveRuntime(settings, next);
  return next;
}

function markError(settings, runtime) {
  const next = {
    ...runtime,
    errorsToday: Number(runtime.errorsToday || 0) + 1
  };

  saveRuntime(settings, next);
  return next;
}

module.exports = {
  getSessionState,
  setSessionState,
  markProcessed,
  markTrade,
  markBlocked,
  markHold,
  markError
};