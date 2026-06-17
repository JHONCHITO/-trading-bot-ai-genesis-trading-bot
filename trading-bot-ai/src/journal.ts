import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { JournalEntry, TradeRecord } from "./types";

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function appendJournalEntry(path: string, entry: JournalEntry): Promise<void> {
  await ensureParentDir(path);
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function recordTradeJournal(
  path: string,
  trade: TradeRecord,
  extra?: Record<string, unknown>,
): Promise<void> {
  await appendJournalEntry(path, {
    ts: Date.now(),
    type: "trade",
    symbol: trade.symbol,
    message: trade.pnl >= 0 ? "trade_win" : "trade_loss",
    payload: {
      trade,
      ...extra,
    },
  });
}

export async function recordDecisionJournal(
  path: string,
  symbol: string,
  message: string,
  payload?: unknown,
): Promise<void> {
  await appendJournalEntry(path, {
    ts: Date.now(),
    type: "decision",
    symbol,
    message,
    payload,
  });
}
