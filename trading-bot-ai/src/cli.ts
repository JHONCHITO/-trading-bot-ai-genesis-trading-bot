import "dotenv/config";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdaptiveCoach, createSignalPackage, loadModelState, saveModelState } from "./ai";
import { DEFAULT_CONFIG } from "./config";
import { createInitialModelState } from "./config";
import { Backtester } from "./backtest";
import { BinanceSpotClient } from "./binance";
import { generateSyntheticCandles } from "./data";
import { TradingBot, PaperBroker, RiskManager } from "./bot";
import { analyzeStructure, buildSeries } from "./utils";
import { buildMarketContext, scoreDirection } from "./market";
import { readMt5MarketFile, writeMt5SignalFile } from "./mt5";
import { blendOpenAIConfidence, reviewSignalWithOpenAI } from "./openai";
import { Candle, MarketContext } from "./types";

type Mode = "backtest" | "paper" | "analyze" | "auto" | "account" | "test-order";
type Exchange = "synthetic" | "binance";

interface CliOptions {
  mode: Mode;
  exchange: Exchange;
  bars: number;
  capital: number;
  symbol: string;
  interval: string;
  intervalMs: number;
  resume: boolean;
  signalFile: string;
  marketFile: string;
}

function getDefaultMt5SignalFile(): string {
  const appData = process.env.APPDATA?.trim();

  if (appData) {
    return join(appData, "MetaQuotes", "Terminal", "Common", "Files", "TradingBotAI", "signal.json");
  }

  return join(process.cwd(), "state", "mt5-signal.json");
}

function getDefaultMt5MarketFile(): string {
  const appData = process.env.APPDATA?.trim();

  if (appData) {
    return join(appData, "MetaQuotes", "Terminal", "Common", "Files", "TradingBotAI", "market.json");
  }

  return join(process.cwd(), "state", "mt5-market.json");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "backtest",
    exchange: "synthetic",
    bars: 240,
    capital: DEFAULT_CONFIG.initialCapital,
    symbol: DEFAULT_CONFIG.symbol,
    interval: "1m",
    intervalMs: Number(process.env.AUTO_INTERVAL_MS || "60000"),
    resume: false,
    signalFile: getDefaultMt5SignalFile(),
    marketFile: getDefaultMt5MarketFile(),
  };
  for (const arg of argv) {
    const [key, value] = arg.split("=");
    if (!key || !value) continue;
    if (key === "--mode" && (value === "backtest" || value === "paper" || value === "analyze" || value === "auto" || value === "account" || value === "test-order")) options.mode = value;
    if (key === "--exchange" && (value === "synthetic" || value === "binance")) options.exchange = value;
    if (key === "--bars") options.bars = Math.max(60, Number(value) || options.bars);
    if (key === "--capital") options.capital = Math.max(1000, Number(value) || options.capital);
    if (key === "--symbol") options.symbol = value.toUpperCase();
    if (key === "--interval") options.interval = value;
    if (key === "--interval-ms") options.intervalMs = Math.max(1000, Number(value) || options.intervalMs);
    if (key === "--resume") options.resume = value === "true" || value === "1";
    if (key === "--signal-file") options.signalFile = value;
    if (key === "--market-file") options.marketFile = value;
  }
  return options;
}

function buildConfig(capital: number, symbol: string) {
  return {
    ...DEFAULT_CONFIG,
    initialCapital: capital,
    symbol,
    modelPath: DEFAULT_CONFIG.modelPath,
    journalPath: DEFAULT_CONFIG.journalPath,
  };
}

async function createBot(loadExisting: boolean, capital: number, symbol: string) {
  const config = buildConfig(capital, symbol);
  const model = loadExisting ? await loadModelState(config.modelPath, createInitialModelState(config)) : createInitialModelState(config);
  const coach = new AdaptiveCoach(model);
  const risk = new RiskManager(config);
  const broker = new PaperBroker(config);
  const bot = new TradingBot(config, coach, risk, broker);
  return { bot, config };
}

function createBinanceClientFromEnv(): BinanceSpotClient {
  const baseUrl = process.env.BINANCE_BASE_URL || "https://testnet.binance.vision/api";
  const apiKey = process.env.BINANCE_API_KEY || "";
  const apiSecret = process.env.BINANCE_API_SECRET || "";

  if (!apiKey || !apiSecret) {
    throw new Error("Missing BINANCE_API_KEY or BINANCE_API_SECRET in your environment.");
  }

  return new BinanceSpotClient({
    baseUrl,
    apiKey,
    apiSecret,
  });
}

async function loadMarketCandles(options: CliOptions): Promise<Candle[]> {
  try {
    const mt5Snapshot = await readMt5MarketFile(options.marketFile);
    if (mt5Snapshot?.bars?.length) {
      return mt5Snapshot.bars.map((bar) => ({
        time: bar.timestamp ?? bar.time,
        timestamp: bar.timestamp ?? bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }));
    }
  } catch {
    // Fall back below if the MT5 market file is missing or unreadable.
  }

  if (options.exchange === "binance") {
    const client = createBinanceClientFromEnv();
    const symbol = options.symbol || process.env.BINANCE_SYMBOL || DEFAULT_CONFIG.symbol;
    return client.getKlines(symbol, options.interval || process.env.BINANCE_INTERVAL || "1m", options.bars);
  }

  return generateSyntheticCandles(options.bars, 100);
}

function printBacktestSummary(report: Awaited<ReturnType<Backtester["run"]>>) {
  console.log("=== Trading bot backtest ===");
  console.table({
    symbol: report.symbol,
    trades: report.trades.length,
    finalEquity: report.finalEquity.toFixed(2),
    netPnL: report.netPnL.toFixed(2),
    winRate: `${(report.winRate * 100).toFixed(2)}%`,
    profitFactor: Number.isFinite(report.profitFactor) ? report.profitFactor.toFixed(2) : "Infinity",
    sharpeLike: report.sharpeLike.toFixed(2),
    maxDrawdown: `${(report.maxDrawdownPct * 100).toFixed(2)}%`,
    halted: report.halted,
  });
  if (report.trades.length) {
    console.log("Recent trades:");
    console.table(report.trades.slice(-10).map((t) => ({
      side: t.side,
      pnl: t.pnl.toFixed(2),
      returnPct: `${(t.returnPct * 100).toFixed(2)}%`,
      durationBars: t.durationBars,
      exitReason: t.exitReason,
      confidence: t.confidence.toFixed(2),
    })));
  }
  console.log("Model weights:");
  console.table(report.modelState.weights);
}

function printStructureReport(context: MarketContext) {
  const series = buildSeries(context.candles);
  const snaps = series.map((s) => analyzeStructure(s.candles, s.timeframe));
  console.log("=== Market structure report ===");
  console.table(snaps.map((s) => ({
    tf: s.timeframe,
    bias: s.bias,
    trend: s.trendStrength.toFixed(2),
    support: s.support.toFixed(2),
    resistance: s.resistance.toFixed(2),
    events: s.events.length,
  })));
  for (const s of snaps) {
    console.log(`--- ${s.timeframe} ---`);
    for (const note of s.notes) console.log(note);
  }
}

async function runAnalyzeOnce(options: CliOptions, bot: TradingBot, config: ReturnType<typeof buildConfig>): Promise<boolean> {
  const candles = await loadMarketCandles(options);
  const context: MarketContext = buildMarketContext(options.symbol || config.symbol, candles);

  if (options.exchange === "binance") {
    console.log(`Exchange: Binance (${process.env.BINANCE_BASE_URL || "https://testnet.binance.vision/api"})`);
  }

  printStructureReport(context);
  const decision = bot.evaluate(context, { equity: config.initialCapital, peakEquity: config.initialCapital, sessionPnl: 0, cooldownBars: 0, openPositions: 0, halted: false });
  console.log("=== Trade decision ===");
  console.log(decision.action.toUpperCase());
  decision.reasons.forEach((reason) => console.log(reason));
  if (!decision.signal) {
    console.log("No signal written.");
    return false;
  }

  const pkg = createSignalPackage(
    options.symbol || config.symbol,
    decision.signal,
    "neutral",
    decision.modelScore ?? decision.signal.confidence,
    decision.reasons.slice(0, 5),
  );

  const openAIEnabled = Boolean(process.env.OPENAI_API_KEY?.trim()) && process.env.OPENAI_DISABLE_REVIEW !== "1";
  if (openAIEnabled) {
    try {
      const review = await reviewSignalWithOpenAI(pkg, context, decision.reasons);
      if (review) {
        pkg.openaiReview = review;
        const originalConfidence = pkg.confidence;
        pkg.confidence = blendOpenAIConfidence(pkg.confidence, review);
        pkg.timeframeNotes = [
          ...pkg.timeframeNotes,
          `OpenAI ${review.verdict.toUpperCase()}: ${review.summary}`,
        ];
        pkg.reasons = [
          ...pkg.reasons,
          `OpenAI adjust ${(pkg.confidence - originalConfidence) >= 0 ? "+" : ""}${(pkg.confidence - originalConfidence).toFixed(3)}`,
        ];

        console.log("=== OpenAI review ===");
        console.table({
          model: review.model,
          verdict: review.verdict,
          confidenceAdjustment: review.confidenceAdjustment.toFixed(3),
          blendedConfidence: pkg.confidence.toFixed(3),
        });
        console.log(review.summary);
        if (review.keyRisks.length) {
          console.log(`OpenAI risks: ${review.keyRisks.join(" | ")}`);
        }
        if (review.suggestions.length) {
          console.log(`OpenAI suggestions: ${review.suggestions.join(" | ")}`);
        }

        if (process.env.OPENAI_STRICT_REVIEW === "1" && review.verdict === "reject") {
          console.log("OpenAI strict review rejected the trade. Signal not written.");
          return false;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`OpenAI review failed, continuing with local analysis only: ${message}`);
    }
  }

  await writeMt5SignalFile(options.signalFile, pkg);
  console.log(`Signal export written to ${options.signalFile}`);
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const shouldResume = options.mode === "paper" || options.resume;
  const { bot, config } = await createBot(shouldResume, options.capital, options.symbol);

  if (options.mode === "account") {
    const client = createBinanceClientFromEnv();
    const account = await client.getAccount();
    const symbol = options.symbol || process.env.BINANCE_SYMBOL || DEFAULT_CONFIG.symbol;
    const selectedBalances = account.balances.filter((balance) => Number(balance.free) > 0 || Number(balance.locked) > 0);

    console.log("=== Binance account ===");
    console.table({
      accountType: account.accountType,
      canTrade: account.canTrade,
      canWithdraw: account.canWithdraw,
      canDeposit: account.canDeposit,
      updateTime: new Date(account.updateTime).toISOString(),
    });
    console.log("Balances:");
    console.table(selectedBalances.map((balance) => ({
      asset: balance.asset,
      free: balance.free,
      locked: balance.locked,
    })));
    console.log(`Cuenta conectada. Symbol actual de trabajo: ${symbol}`);
    return;
  }

  if (options.mode === "paper") {
    await mkdir(dirname(config.modelPath), { recursive: true });
    await saveModelState(config.modelPath, bot.getModelState());
    console.log("Paper mode ready. Connect live data and broker next.");
    return;
  }

  if (options.mode === "analyze") {
    await runAnalyzeOnce(options, bot, config);
    return;
  }

  if (options.mode === "auto") {
    console.log(`Auto mode started. Interval ${options.intervalMs} ms. Press Ctrl+C to stop.`);
    for (;;) {
      try {
        await runAnalyzeOnce(options, bot, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Auto cycle failed: ${message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  }

  if (options.mode === "test-order") {
    const client = createBinanceClientFromEnv();
    const testOrderSide = (process.env.BINANCE_TEST_ORDER_SIDE || "BUY").toUpperCase() as "BUY" | "SELL";
    const testOrderType = (process.env.BINANCE_TEST_ORDER_TYPE || "MARKET").toUpperCase() as "MARKET" | "LIMIT";
    const testOrderQty = process.env.BINANCE_TEST_ORDER_QTY || "0.001";
    const symbol = options.symbol || process.env.BINANCE_SYMBOL || DEFAULT_CONFIG.symbol;

    const response = await client.testOrder({
      symbol,
      side: testOrderSide,
      type: testOrderType,
      quantity: testOrderQty,
      recvWindow: 5000,
    });

    console.log("=== Binance test order ===");
    console.dir(response, { depth: null });
    return;
  }

  const candles = await loadMarketCandles(options);
  const report = await new Backtester(config, bot).run(candles);
  printBacktestSummary(report);
}

main().catch((error) => {
  console.error("Trading bot CLI failed:", error);
  process.exitCode = 1;
});
