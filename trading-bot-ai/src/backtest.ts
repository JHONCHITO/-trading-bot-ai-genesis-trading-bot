import { saveModelState } from "./ai";
import { BotConfig, Candle, PortfolioState, Position, TradeRecord } from "./types";
import { buildMarketContext } from "./market";
import { TradingBot } from "./bot";
// import { appendTradeJournal } from "./utils"; // descomenta si esa función existe ahí

function resolveExit(position: Position, candle: Candle) {
  const long = position.plan.side === "buy";
  const stopHit = long ? candle.low <= position.plan.stopLoss : candle.high >= position.plan.stopLoss;
  const targetHit = long ? candle.high >= position.plan.takeProfit : candle.low <= position.plan.takeProfit;

  if (stopHit && targetHit) return { price: position.plan.stopLoss, reason: "stop-loss (conservative)" };
  if (stopHit) return { price: position.plan.stopLoss, reason: "stop-loss" };
  if (targetHit) return { price: position.plan.takeProfit, reason: "take-profit" };

  return null;
}

function pnl(position: Position, exitPrice: number, config: BotConfig) {
  const entry = position.entryFill.price;
  const commission = position.entryFill.commission + position.plan.units * config.commissionPerUnit;
  const gross =
    position.plan.side === "buy"
      ? (exitPrice - entry) * position.plan.units
      : (entry - exitPrice) * position.plan.units;

  return gross - commission;
}

export class Backtester {
  constructor(
    private readonly config: BotConfig,
    private readonly bot: TradingBot
  ) {}

  async run(candles: Candle[]) {
    const state: PortfolioState = {
      equity: this.config.initialCapital,
      peakEquity: this.config.initialCapital,
      sessionPnl: 0,
      cooldownBars: 0,
      openPositions: 0,
      halted: false,
    };

    const trades: TradeRecord[] = [];
    const equityCurve: number[] = [];
    let openPosition: Position | null = null;
    let maxDrawdown = 0;
    const lookback = Math.max(this.config.trendSlow, this.config.atrLookback) + 1;

    for (let i = lookback; i < candles.length; i += 1) {
      const context = buildMarketContext(this.config.symbol, candles.slice(0, i + 1));

      if (state.cooldownBars > 0) {
        state.cooldownBars -= 1;
      }

      if (openPosition) {
        const exit = resolveExit(openPosition, candles[i]);

        if (exit) {
          const exitFill = this.bot.getBroker().fillExit(openPosition.plan, context);
          exitFill.price = exit.price;

          const tradePnl = pnl(openPosition, exitFill.price, this.config);
          state.equity += tradePnl;
          state.sessionPnl += tradePnl;
          state.peakEquity = Math.max(state.peakEquity, state.equity);
          maxDrawdown = Math.max(maxDrawdown, 1 - state.equity / state.peakEquity);
          state.openPositions = 0;

          if (tradePnl < 0) {
            state.cooldownBars = this.config.cooldownBarsAfterLoss;
          }

          const trade: TradeRecord = {
            symbol: openPosition.plan.symbol,
            side: openPosition.plan.side,
            units: openPosition.plan.units,
            entryPrice: openPosition.entryFill.price,
            exitPrice: exitFill.price,
            entryTimestamp: openPosition.entryFill.timestamp,
            exitTimestamp: candles[i].timestamp,
            pnl: tradePnl,
            returnPct: tradePnl / Math.max(openPosition.entryFill.price * openPosition.plan.units, 1),
            durationBars: i - openPosition.entryIndex,
            exitReason: exit.reason,
            confidence: openPosition.plan.confidence,
            features: openPosition.features,
            modelScore: openPosition.modelScore,
          };

          trades.push(trade);
          this.bot.learn(trade);
          openPosition = null;
        }
      }

      if (state.equity <= this.config.initialCapital * (1 - this.config.maxDrawdownPct)) {
        state.halted = true;
      }

      if (!openPosition && !state.halted) {
        const decision = this.bot.evaluate(context, state);

        if (
          (decision.action === "enter-long" || decision.action === "enter-short") &&
          decision.plan
        ) {
          const entryFill = this.bot.getBroker().fillEntry(decision.plan, context);

          openPosition = {
            plan: decision.plan,
            entryFill,
            entryIndex: i,
            features:
              decision.signal?.features ?? {
                trend: 0,
                flow: 0,
                breakout: 0,
                volume: 0,
                volatility: 0,
                spread: 0,
              },
            modelScore: decision.modelScore ?? 0,
          };

          state.openPositions = 1;
        }
      }

      equityCurve.push(state.equity);
    }

    if (openPosition) {
      const last = candles[candles.length - 1];
      const context = buildMarketContext(this.config.symbol, candles);
      const exitFill = this.bot.getBroker().fillExit(openPosition.plan, context);
      exitFill.price = last.close;

      const tradePnl = pnl(openPosition, exitFill.price, this.config);
      state.equity += tradePnl;
      state.sessionPnl += tradePnl;
      state.peakEquity = Math.max(state.peakEquity, state.equity);
      maxDrawdown = Math.max(maxDrawdown, 1 - state.equity / state.peakEquity);

      const trade: TradeRecord = {
        symbol: openPosition.plan.symbol,
        side: openPosition.plan.side,
        units: openPosition.plan.units,
        entryPrice: openPosition.entryFill.price,
        exitPrice: exitFill.price,
        entryTimestamp: openPosition.entryFill.timestamp,
        exitTimestamp: last.timestamp,
        pnl: tradePnl,
        returnPct: tradePnl / Math.max(openPosition.entryFill.price * openPosition.plan.units, 1),
        durationBars: candles.length - 1 - openPosition.entryIndex,
        exitReason: "session close",
        confidence: openPosition.plan.confidence,
        features: openPosition.features,
        modelScore: openPosition.modelScore,
      };

      trades.push(trade);
      this.bot.learn(trade);
      // await appendTradeJournal(this.config.journalPath, trade);
    }

    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl < 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
    const profitFactor =
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0;
    const winRate = trades.length ? wins.length / trades.length : 0;
    const avgReturn =
      trades.length
        ? trades.reduce((sum, t) => sum + t.returnPct, 0) / trades.length
        : 0;
    const std =
      trades.length > 1
        ? Math.sqrt(
            trades.reduce((sum, t) => sum + (t.returnPct - avgReturn) ** 2, 0) /
              (trades.length - 1)
          )
        : 0;
    const sharpeLike = std > 0 ? avgReturn / std : 0;

    await saveModelState(this.config.modelPath, this.bot.getModelState());

    return {
      symbol: this.config.symbol,
      initialCapital: this.config.initialCapital,
      finalEquity: state.equity,
      netPnL: state.equity - this.config.initialCapital,
      maxDrawdownPct: maxDrawdown,
      winRate,
      profitFactor,
      sharpeLike,
      trades,
      equityCurve,
      halted: state.halted,
      modelState: this.bot.getModelState(),
    };
  }
}