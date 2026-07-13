import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Mt5MarketSnapshot, SignalPackage } from "./types";

function cleanJsonText(raw: string): string {
  return raw.replace(/^\uFEFF/, "").trim();
}

async function readJsonFileRobust<T>(path: string): Promise<T | null> {
  try {
    const rawUtf8 = await readFile(path, "utf8");
    const cleanUtf8 = cleanJsonText(rawUtf8);
    if (!cleanUtf8) return null;
    return JSON.parse(cleanUtf8) as T;
  } catch {
    try {
      const rawUtf16 = await readFile(path, "utf16le");
      const cleanUtf16 = cleanJsonText(rawUtf16);
      if (!cleanUtf16) return null;
      return JSON.parse(cleanUtf16) as T;
    } catch {
      return null;
    }
  }
}

function normalizeMarketSnapshot(snapshot: Mt5MarketSnapshot): Mt5MarketSnapshot {
  return {
    ...snapshot,
    bars: snapshot.bars.map((bar) => ({
      ...bar,
      time: bar.time ?? bar.timestamp ?? 0,
      timestamp: bar.timestamp ?? bar.time ?? 0,
    })),
  };
}

export async function writeMt5SignalFile(path: string, signal: SignalPackage): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const payload = {
    generatedAt: new Date().toISOString(),
    signalId: signal.signalId,
    action: signal.side.toUpperCase(),
    symbol: signal.symbol,
    side: signal.side,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    confidence: signal.confidence,
    confluenceScore: signal.confluenceScore,
    modelScore: signal.confluenceScore,
    regime: signal.regime,
    timeframeNotes: signal.timeframeNotes,
    reasons: signal.reasons,
    features: signal.features,
    openaiReview: signal.openaiReview ?? undefined,
  };
  const tempPath = `${path}.tmp`;

  await writeFile(
    tempPath,
    JSON.stringify(payload, null, 2),
    "utf8",
  );

  try {
    await rename(tempPath, path);
  } catch {
    await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  }
}

export async function readMt5SignalFile(path: string): Promise<SignalPackage | null> {
  return readJsonFileRobust<SignalPackage>(path);
}

export async function readMt5MarketFile(path: string): Promise<Mt5MarketSnapshot | null> {
  const snapshot = await readJsonFileRobust<Mt5MarketSnapshot>(path);
  return snapshot ? normalizeMarketSnapshot(snapshot) : null;
}
