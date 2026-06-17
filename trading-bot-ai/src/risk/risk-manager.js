import { BotConfig, PortfolioState, TradeSignal } from "./types";

export class RiskManager {
  constructor(private readonly config: BotConfig) {}

  private roundDownToStep(value: number, step: number): number {
    if (!step || step <= 0) return value;
    return Math.floor(value / step) * step;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  public canTrade(portfolio: PortfolioState): { ok: boolean; reason?: string } {
    if (portfolio.halted) {
      return { ok: false, reason: "portfolio halted" };
    }

    if (portfolio.openPositions >= this.config.maxOpenPositions) {
      return { ok: false, reason: "max open positions reached" };
    }

    if (portfolio.cooldownBars > 0) {
      return { ok: false, reason: "cooldown active" };
    }

    const drawdownPct =
      portfolio.peakEquity > 0
        ? ((portfolio.peakEquity - portfolio.equity) / portfolio.peakEquity) * 100
        : 0;

    if (drawdownPct >= this.config.maxDailyLossPct) {
      return { ok: false, reason: "daily loss limit reached" };
    }

    return { ok: true };
  }

  public sizePosition(signal: TradeSignal, portfolio: PortfolioState): number {
    const riskPerTrade = this.config.riskPerTrade ?? 0.01;
    const pointValue = this.config.execution?.pointValue ?? 1;
    const minUnits = this.config.execution?.minUnits ?? 1;
    const maxUnits = this.config.execution?.maxUnits ?? 100000;
    const unitStep = this.config.execution?.unitStep ?? 1;

    const stopDistance = Math.abs(signal.entry - signal.stopLoss);
    if (!stopDistance || stopDistance <= 0) return 0;

    const riskAmount = portfolio.equity * riskPerTrade;
    const rawUnits = riskAmount / (stopDistance * pointValue);
    const steppedUnits = this.roundDownToStep(rawUnits, unitStep);
    const finalUnits = this.clamp(steppedUnits, 0, maxUnits);

    if (!finalUnits || finalUnits < minUnits) {
      return 0;
    }

    return finalUnits;
  }

  public validateSignal(
    signal: TradeSignal,
    portfolio: PortfolioState
  ): { ok: boolean; reason?: string; units?: number } {
    const tradeCheck = this.canTrade(portfolio);
    if (!tradeCheck.ok) {
      return { ok: false, reason: tradeCheck.reason };
    }

    const units = this.sizePosition(signal, portfolio);
    if (!units || units <= 0) {
      return { ok: false, reason: "Position size too small" };
    }

    return { ok: true, units };
  }
}