import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdaptiveCoach, loadModelState } from "./ai";
import { TradingBot, RiskManager, PaperBroker } from "./bot";
import { DEFAULT_CONFIG, createInitialModelState } from "./config";
import { loadNewsState, evaluateNewsState } from "./news";
import { recordDecisionJournal } from "./journal";
import { readMt5MarketFile, readMt5SignalFile, writeMt5SignalFile } from "./mt5";
import {
  BotDecision,
  MarketContext,
  Mt5MarketSnapshot,
  PortfolioState,
  SignalPackage,
} from "./types";

const config = DEFAULT_CONFIG;

// RUTAS REALES DE MT5 COMMON FILES
const MT5_MARKET_PATH =
  "C:/Users/Jjtoc/AppData/Roaming/MetaQuotes/Terminal/Common/Files/TradingBotAI/market.json";

const MT5_SIGNAL_PATH =
  "C:/Users/Jjtoc/AppData/Roaming/MetaQuotes/Terminal/Common/Files/TradingBotAI/signal.json";

const NEWS_FILE_PATH = process.env.APPDATA?.trim()
  ? join(process.env.APPDATA.trim(), "MetaQuotes", "Terminal", "Common", "Files", "TradingBotAI", "news.json")
  : "./state/news.json";

// Estado local del bot
const BOT_RUNTIME_STATE_PATH = "./state/runtime-state.json";

interface RuntimeState {
  lastProcessedGeneratedAt: number;
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function loadRuntimeState(): Promise<RuntimeState> {
  try {
    const raw = await readFile(BOT_RUNTIME_STATE_PATH, "utf8");
    return JSON.parse(raw) as RuntimeState;
  } catch {
    const initial: RuntimeState = { lastProcessedGeneratedAt: 0 };
    await ensureParentDir(BOT_RUNTIME_STATE_PATH);
    await writeFile(BOT_RUNTIME_STATE_PATH, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
}

async function saveRuntimeState(state: RuntimeState): Promise<void> {
  await ensureParentDir(BOT_RUNTIME_STATE_PATH);
  await writeFile(BOT_RUNTIME_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function buildSyntheticBookFromBars(snapshot: Mt5MarketSnapshot) {
  const last = snapshot.bars[snapshot.bars.length - 1];
  const price = last?.close ?? 0;
  const syntheticSpread = Math.max(price * 0.0001, 1);

  return {
    bestBid: price - syntheticSpread / 2,
    bestAsk: price + syntheticSpread / 2,
    bidSize: last?.volume ?? 1,
    askSize: last?.volume ?? 1,
  };
}

function snapshotToMarketContext(snapshot: Mt5MarketSnapshot): MarketContext | null {
  if (!snapshot?.bars?.length) return null;
  if (snapshot.bars.length < config.trendSlow) return null;

  const candles = snapshot.bars.map((bar) => ({
    time: bar.timestamp ?? bar.time,
    timestamp: bar.timestamp ?? bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));

  return {
    symbol: snapshot.symbol,
    timestamp: snapshot.generatedAt,
    candles,
    book: buildSyntheticBookFromBars(snapshot),
  };
}

function createPortfolioState(): PortfolioState {
  return {
    equity: config.initialCapital,
    peakEquity: config.initialCapital,
    sessionPnl: 0,
    cooldownBars: 0,
    openPositions: 0,
    halted: false,
  };
}

function decisionToSignalPackage(decision: BotDecision, context: MarketContext): SignalPackage | null {
  if (!decision.signal) return null;
  if (decision.action !== "enter-long" && decision.action !== "enter-short") return null;

  return {
    symbol: context.symbol,
    side: decision.signal.side,
    entry: decision.signal.entry,
    stopLoss: decision.signal.stopLoss,
    takeProfit: decision.signal.takeProfit,
    confidence: decision.signal.confidence,
    reasons: decision.signal.reasons,
    features: decision.signal.features,
    confluenceScore: decision.modelScore ?? decision.signal.confidence,
    regime: decision.signal.side === "buy" ? "bullish" : "bearish",
    timeframeNotes: decision.reasons,
    openaiReview: undefined,
  };
}

function isSameSignal(a: SignalPackage | null, b: SignalPackage | null): boolean {
  if (!a || !b) return false;

  return (
    a.symbol === b.symbol &&
    a.side === b.side &&
    a.entry === b.entry &&
    a.stopLoss === b.stopLoss &&
    a.takeProfit === b.takeProfit
  );
}

async function run(): Promise<void> {
  const fallbackModel = createInitialModelState(config);
  const modelState = await loadModelState(config.modelPath, fallbackModel);
  const runtimeState = await loadRuntimeState();

  const coach = new AdaptiveCoach(modelState);
  const risk = new RiskManager(config);
  const broker = new PaperBroker(config);
  const bot = new TradingBot(config, coach, risk, broker);

  const portfolio = createPortfolioState();

  console.log("[BOT] Iniciado");
  console.log("[BOT] Leyendo mercado desde:", MT5_MARKET_PATH);
  console.log("[BOT] Escribiendo señales en:", MT5_SIGNAL_PATH);

  setInterval(async () => {
    try {
      if (!existsSync(MT5_MARKET_PATH)) {
        console.log("[BOT] Aun no existe market.json en MT5 Common Files");
        return;
      }

      const snapshot = await readMt5MarketFile(MT5_MARKET_PATH);
      if (!snapshot) {
        console.log("[BOT] No se pudo leer market.json");
        return;
      }

      if (snapshot.generatedAt <= runtimeState.lastProcessedGeneratedAt) {
        return;
      }

      console.log(
        `[BOT] Nuevo snapshot detectado: ${snapshot.symbol} ${snapshot.timeframe} bars=${snapshot.bars.length}`
      );

      const context = snapshotToMarketContext(snapshot);
      if (!context) {
        console.log("[BOT] Snapshot insuficiente. Necesita más barras.");
        runtimeState.lastProcessedGeneratedAt = snapshot.generatedAt;
        await saveRuntimeState(runtimeState);
        return;
      }

      const news = await loadNewsState(NEWS_FILE_PATH);
      const newsCheck = evaluateNewsState(news, context.symbol, Math.floor(context.timestamp / 1000));
      const decision = bot.evaluate(
        context,
        portfolio,
        newsCheck.blocked ? { newsBlocked: true, newsReasons: newsCheck.reasons } : undefined,
      );
      const nextSignal = decisionToSignalPackage(decision, context);
      const currentSignal = await readMt5SignalFile(MT5_SIGNAL_PATH);

      await recordDecisionJournal(config.journalPath, context.symbol, decision.action, {
        reasons: decision.reasons,
        blockedByNews: newsCheck.blocked,
        newsReasons: newsCheck.reasons,
      });

      if (nextSignal && !isSameSignal(currentSignal, nextSignal)) {
        await writeMt5SignalFile(MT5_SIGNAL_PATH, nextSignal);
        console.log(
          `[SIGNAL] ${nextSignal.side.toUpperCase()} ${nextSignal.symbol} entry=${nextSignal.entry} sl=${nextSignal.stopLoss} tp=${nextSignal.takeProfit}`
        );
      } else {
        console.log(`[BOT] ${decision.action} :: ${decision.reasons.join(" | ")}`);
        if (newsCheck.blocked) {
          console.log(`[NEWS] ${newsCheck.reasons.join(" | ")}`);
        }
      }

      runtimeState.lastProcessedGeneratedAt = snapshot.generatedAt;
      await saveRuntimeState(runtimeState);
    } catch (error) {
      console.error("[BOT ERROR]", error);
    }
  }, 2000);
}

run().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
