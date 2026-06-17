import { saveModelState, cloneModelState } from "./ai";
import { PaperBroker, RiskManager, TradingBot } from "./bot";
import { BotConfig, Candle, PortfolioState, Position, TradeRecord, BacktestFoldReport, WalkForwardReport } from "./types";
import { buildMarketContext } from "./market";
import { appendTradeJournal } from "./ai";
import { recordTradeJournal } from "./journal";
import { loadNewsState, evaluateNewsState } from "./news";
import { AdaptiveCoach } from "./ai";

export interface BacktestReport {
  symbol: string;
  initialCapital: number;
  finalEquity: number;
  netPnL: number;
  maxDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  sharpeLike: number;
  expectancy: number;
  avgTradePnL: number;
  trades: TradeRecord[];
  equityCurve: number[];
  halted: boolean;
  modelState: ReturnType<TradingBot["getModelState"]>;
}

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

function createState(config: BotConfig): PortfolioState {
  return {
    equity: config.initialCapital,
    peakEquity: config.initialCapital,
    sessionPnl: 0,
    cooldownBars: 0,
    openPositions: 0,
    halted: false,
  };
}

function computeMetrics(trades: TradeRecord[]) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0;
  const winRate = trades.length ? wins.length / trades.length : 0;
  const avgTradePnL = trades.length ? trades.reduce((sum, t) => sum + t.pnl, 0) / trades.length : 0;
  const expectancy = avgTradePnL;
  const avgReturn = trades.length ? trades.reduce((sum, t) => sum + t.returnPct, 0) / trades.length : 0;
  const std =
    trades.length > 1
      ? Math.sqrt(
          trades.reduce((sum, t) => sum + (t.returnPct - avgReturn) ** 2, 0) / (trades.length - 1),
        )
      : 0;
  const sharpeLike = std > 0 ? avgReturn / std : 0;

  return { wins, losses, grossProfit, grossLoss, profitFactor, winRate, avgTradePnL, expectancy, sharpeLike };
}

async function runSingleBacktest(
  config: BotConfig,
  bot: TradingBot,
  candles: Candle[],
  journalPath?: string,
): Promise<BacktestReport> {
  const state = createState(config);
  const trades: TradeRecord[] = [];
  const equityCurve: number[] = [];
  let openPosition: Position | null = null;
  let maxDrawdown = 0;
  const lookback = Math.max(config.trendSlow, config.atrLookback) + 1;
  const news = await loadNewsState(config.newsPath);

  for (let i = lookback; i < candles.length; i += 1) {
    const context = buildMarketContext(config.symbol, candles.slice(0, i + 1));
    const newsCheck = evaluateNewsState(news, context.symbol, Math.floor(context.timestamp / 1000));

    if (state.cooldownBars > 0) {
      state.cooldownBars -= 1;
    }

    if (openPosition) {
      const exit = resolveExit(openPosition, candles[i]);

      if (exit) {
        const exitFill = bot.getBroker().fillExit(openPosition.plan, context);
        exitFill.price = exit.price;

        const tradePnl = pnl(openPosition, exitFill.price, config);
        state.equity += tradePnl;
        state.sessionPnl += tradePnl;
        state.peakEquity = Math.max(state.peakEquity, state.equity);
        maxDrawdown = Math.max(maxDrawdown, 1 - state.equity / state.peakEquity);
        state.openPositions = 0;

        if (tradePnl < 0) {
          state.cooldownBars = config.cooldownBarsAfterLoss;
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
        bot.learn(trade);

        if (journalPath) {
          await recordTradeJournal(journalPath, trade, { phase: "backtest" });
        }

        openPosition = null;
      }
    }

    if (state.equity <= config.initialCapital * (1 - config.maxDrawdownPct)) {
      state.halted = true;
    }

    if (!openPosition && !state.halted) {
      const decision = bot.evaluate(
        context,
        state,
        newsCheck.blocked ? { newsBlocked: true, newsReasons: newsCheck.reasons } : undefined,
      );

      if ((decision.action === "enter-long" || decision.action === "enter-short") && decision.plan) {
        if (newsCheck.blocked) {
          state.cooldownBars = Math.max(state.cooldownBars, config.cooldownBarsAfterLoss);
        } else {
          const entryFill = bot.getBroker().fillEntry(decision.plan, context);

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
    }

    equityCurve.push(state.equity);
  }

  if (openPosition) {
    const last = candles[candles.length - 1];
    const context = buildMarketContext(config.symbol, candles);
    const exitFill = bot.getBroker().fillExit(openPosition.plan, context);
    exitFill.price = last.close;

    const tradePnl = pnl(openPosition, exitFill.price, config);
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
    bot.learn(trade);

    if (journalPath) {
      await appendTradeJournal(journalPath, trade);
    }
  }

  const metrics = computeMetrics(trades);
  await saveModelState(config.modelPath, bot.getModelState());

  return {
    symbol: config.symbol,
    initialCapital: config.initialCapital,
    finalEquity: state.equity,
    netPnL: state.equity - config.initialCapital,
    maxDrawdownPct: maxDrawdown,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    sharpeLike: metrics.sharpeLike,
    expectancy: metrics.expectancy,
    avgTradePnL: metrics.avgTradePnL,
    trades,
    equityCurve,
    halted: state.halted,
    modelState: bot.getModelState(),
  };
}

export class Backtester {
  constructor(
    private readonly config: BotConfig,
    private readonly bot: TradingBot,
  ) {}

  async run(candles: Candle[]): Promise<BacktestReport> {
    return runSingleBacktest(this.config, this.bot, candles, this.config.journalPath);
  }
}

function buildFoldReport(
  fold: number,
  train: BacktestReport,
  test: BacktestReport,
  trainBars: number,
  testBars: number,
): BacktestFoldReport {
  return {
    fold,
    trainBars,
    testBars,
    trainEquity: train.finalEquity,
    testEquity: test.finalEquity,
    trainNetPnL: train.netPnL,
    testNetPnL: test.netPnL,
    trainTrades: train.trades.length,
    testTrades: test.trades.length,
    trainWinRate: train.winRate,
    testWinRate: test.winRate,
    trainProfitFactor: train.profitFactor,
    testProfitFactor: test.profitFactor,
    testSharpeLike: test.sharpeLike,
    maxDrawdownPct: Math.max(train.maxDrawdownPct, test.maxDrawdownPct),
  };
}

export async function runWalkForward(config: BotConfig, initialModelState: ReturnType<TradingBot["getModelState"]>, candles: Candle[], folds = 4): Promise<WalkForwardReport> {
  const usableFolds = Math.max(2, Math.min(folds, Math.floor(candles.length / 100) || 2));
  const segmentSize = Math.max(50, Math.floor(candles.length / (usableFolds + 1)));
  const foldReports: BacktestFoldReport[] = [];
  let totalTrades = 0;
  let equity = config.initialCapital;
  let netPnL = 0;
  let worstDrawdown = 0;

  for (let fold = 0; fold < usableFolds; fold += 1) {
    const trainEnd = Math.min(candles.length - segmentSize, segmentSize * (fold + 1));
    const testEnd = Math.min(candles.length, trainEnd + segmentSize);
    const trainCandles = candles.slice(0, trainEnd);
    const testCandles = candles.slice(trainEnd, testEnd);
    if (trainCandles.length < config.trendSlow + 10 || testCandles.length < config.trendSlow + 10) {
      continue;
    }

    const trainBot = new TradingBot(
      config,
      new AdaptiveCoach(cloneModelState(initialModelState)),
      new RiskManager(config),
      new PaperBroker(config),
    );
    const trainReport = await runSingleBacktest(config, trainBot, trainCandles);

    const testBot = new TradingBot(
      config,
      new AdaptiveCoach(cloneModelState(trainReport.modelState)),
      new RiskManager(config),
      new PaperBroker(config),
    );
    const testReport = await runSingleBacktest(config, testBot, testCandles);

    const foldReport = buildFoldReport(fold + 1, trainReport, testReport, trainCandles.length, testCandles.length);
    foldReports.push(foldReport);
    totalTrades += testReport.trades.length;
    equity = testReport.finalEquity;
    netPnL = testReport.netPnL;
    worstDrawdown = Math.max(worstDrawdown, foldReport.maxDrawdownPct);
  }

  const averageWinRate =
    foldReports.length > 0 ? foldReports.reduce((sum, fold) => sum + fold.testWinRate, 0) / foldReports.length : 0;
  const averageProfitFactor =
    foldReports.length > 0 ? foldReports.reduce((sum, fold) => sum + fold.testProfitFactor, 0) / foldReports.length : 0;
  const averageSharpeLike =
    foldReports.length > 0 ? foldReports.reduce((sum, fold) => sum + fold.testSharpeLike, 0) / foldReports.length : 0;

  return {
    folds: foldReports,
    totalTrades,
    averageWinRate,
    averageProfitFactor,
    averageSharpeLike,
    worstDrawdownPct: worstDrawdown,
    finalEquity: equity,
    netPnL,
  };
}
