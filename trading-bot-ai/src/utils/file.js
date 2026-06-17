const fs = require('fs');
const path = require('path');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function writeJson(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function appendLine(filePath, line) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${line}\n`, 'utf8');
}

module.exports = {
  ensureDir,
  readJsonSafe,
  writeJson,
  appendLine
};