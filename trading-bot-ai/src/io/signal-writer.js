const { writeJson } = require('../utils/file');

function writeSignal(settings, payload) {
  writeJson(settings.io.signalFile, payload);
}

module.exports = { writeSignal };