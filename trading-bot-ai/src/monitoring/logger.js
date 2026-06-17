const { appendLine } = require('../utils/file');
const { nowIso } = require('../utils/time');

function logEvent(filePath, level, event, payload = {}) {
  appendLine(filePath, JSON.stringify({
    ts: nowIso(),
    level,
    event,
    ...payload
  }));
}

module.exports = { logEvent };