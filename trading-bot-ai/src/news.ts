import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { NewsEvent, NewsSeverity, NewsState } from "./types";
import { clamp } from "./utils";

function parseTimeValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }

  if (typeof value === "string" && value.trim()) {
    const raw = value.trim();
    if (/^\d+(\.\d+)?$/.test(raw)) {
      const numeric = Number(raw);
      return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
    }

    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }

  return 0;
}

function normalizeSeverity(value: unknown): NewsSeverity {
  const severity = String(value ?? "medium").toLowerCase();
  if (severity === "low" || severity === "medium" || severity === "high" || severity === "critical") {
    return severity;
  }
  return "medium";
}

function normalizeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 10);
}

function normalizeEvent(event: Record<string, unknown>): NewsEvent {
  const severity = normalizeSeverity(event.severity);
  const beforeMinutes = clamp(Number(event.beforeMinutes ?? 30), 0, 240);
  const afterMinutes = clamp(Number(event.afterMinutes ?? 30), 0, 240);

  return {
    title: String(event.title ?? event.event ?? "News event"),
    timestamp: parseTimeValue(event.timestamp ?? event.eventAt ?? event.time ?? event.datetime),
    currency: event.currency ? String(event.currency).toUpperCase() : undefined,
    symbols: normalizeArray(event.symbols),
    severity,
    beforeMinutes,
    afterMinutes,
    blocked: Boolean(event.blocked ?? (severity === "high" || severity === "critical")),
    source: event.source ? String(event.source) : undefined,
  };
}

export function normalizeNewsState(raw: Record<string, unknown>): NewsState {
  const events = Array.isArray(raw.events)
    ? raw.events.map((event) => normalizeEvent(event as Record<string, unknown>)).filter((event) => event.timestamp > 0)
    : [];

  return {
    source: String(raw.source ?? "manual"),
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
    blocked: Boolean(raw.blocked ?? false),
    blackoutUntil: parseTimeValue(raw.blackoutUntil ?? raw.blackout_until),
    events,
  };
}

export async function loadNewsState(path: string): Promise<NewsState | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return null;
    return normalizeNewsState(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function evaluateNewsState(
  news: NewsState | null,
  symbol: string,
  now = Math.floor(Date.now() / 1000),
): { blocked: boolean; reasons: string[] } {
  if (!news) return { blocked: false, reasons: [] };

  const reasons: string[] = [];
  if (news.blocked) reasons.push("News state blocked");
  if (news.blackoutUntil && now < news.blackoutUntil) reasons.push("News blackout active");

  for (const event of news.events) {
    if (!event.timestamp) continue;
    const symbolMatch =
      !event.symbols?.length ||
      event.symbols.some((item) => item.toLowerCase() === symbol.toLowerCase());
    const currencyMatch =
      !event.currency ||
      symbol.toUpperCase().includes(event.currency.toUpperCase()) ||
      symbol.toUpperCase().includes("USD");

    if (!symbolMatch && !currencyMatch) continue;

    const windowStart = event.timestamp - event.beforeMinutes * 60;
    const windowEnd = event.timestamp + event.afterMinutes * 60;
    if (now >= windowStart && now <= windowEnd) {
      reasons.push(`${event.title} (${event.severity})`);
      if (event.blocked) {
        return { blocked: true, reasons };
      }
    }
  }

  return { blocked: reasons.length > 0, reasons };
}
