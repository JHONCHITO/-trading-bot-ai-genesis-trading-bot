function roundDownToStep(value, step) {
  if (!step || step <= 0) return value;
  return Math.floor(value / step) * step;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function enrichWithPositionSize(signal, settings, market) {
  const reasons = [...(signal.reasons || [])];

  if (!signal.riskOk) {
    return signal;
  }

  const equity = Number(settings.account.equity || 0);
  const riskPct = Number(settings.risk.riskPerTrade || 0);
  const minUnits = Number(settings.execution.minUnits || 1);
  const maxUnits = Number(settings.execution.maxUnits || 1000000);
  const unitStep = Number(settings.execution.unitStep || 1);
  const pointValue = Number(settings.execution.pointValue || 1);

  const entry = Number(signal.entry || 0);
  const stopLoss = Number(signal.stopLoss || 0);
  const stopDistance = Math.abs(entry - stopLoss);

  if (!equity || !riskPct || !entry || !stopLoss || !stopDistance || !pointValue) {
    return {
      ...signal,
      action: 'HOLD',
      state: 'BLOCKED_RISK',
      riskOk: false,
      reasons: [...reasons, 'invalid_position_inputs']
    };
  }

  const riskAmount = equity * riskPct;
  const rawUnits = riskAmount / (stopDistance * pointValue);
  const sizedUnits = roundDownToStep(rawUnits, unitStep);
  const finalUnits = clamp(sizedUnits, 0, maxUnits);

  if (!finalUnits || finalUnits < minUnits) {
    return {
      ...signal,
      action: 'HOLD',
      state: 'BLOCKED_RISK',
      riskOk: false,
      reasons: [...reasons, 'Position size too small'],
      units: 0
    };
  }

  return {
    ...signal,
    units: finalUnits
  };
}

module.exports = { enrichWithPositionSize };