function nowIso() {
  return new Date().toISOString();
}

function diffSeconds(isoA, isoB) {
  if (!isoA || !isoB) return Number.POSITIVE_INFINITY;
  return Math.floor((new Date(isoA).getTime() - new Date(isoB).getTime()) / 1000);
}

function diffSecondsMs(msA, msB) {
  if (!msA || !msB) return Number.POSITIVE_INFINITY;
  return Math.floor((Number(msA) - Number(msB)) / 1000);
}

function sessionDay(iso) {
  const date = iso ? new Date(iso) : new Date();
  return date.toISOString().slice(0, 10);
}

module.exports = {
  nowIso,
  diffSeconds,
  diffSecondsMs,
  sessionDay
};