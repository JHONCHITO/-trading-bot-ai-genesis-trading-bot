import OpenAI from "openai";
import { clamp } from "./utils";
import { OpenAIReview, SignalPackage, MarketContext } from "./types";

type ReviewVerdict = OpenAIReview["verdict"];

function getApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? key : null;
}

function getModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

function getReviewWeight(): number {
  const parsed = Number(process.env.OPENAI_REVIEW_WEIGHT || "0.35");
  return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : 0.35;
}

function normalizeVerdict(value: unknown): ReviewVerdict {
  if (value === "approve" || value === "caution" || value === "reject") return value;
  return "caution";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 8);
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildReviewPrompt(signal: SignalPackage, context: MarketContext, reasons: string[]) {
  return {
    symbol: signal.symbol,
    side: signal.side,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    confidence: signal.confidence,
    confluenceScore: signal.confluenceScore,
    regime: signal.regime,
    timeframeNotes: signal.timeframeNotes,
    reasons,
    market: {
      timestamp: context.timestamp,
      candles: context.candles.length,
      bestBid: context.book.bestBid,
      bestAsk: context.book.bestAsk,
      spreadPct: Number(((context.book.bestAsk - context.book.bestBid) / ((context.book.bestBid + context.book.bestAsk) / 2)).toFixed(6)),
    },
  };
}

export async function reviewSignalWithOpenAI(signal: SignalPackage, context: MarketContext, reasons: string[]): Promise<OpenAIReview | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const client = new OpenAI({ apiKey });
  const model = getModel();
  const payload = buildReviewPrompt(signal, context, reasons);

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a conservative trading risk reviewer. Review one proposed trade. Focus on structure, execution risk, and whether the trade should be approved. Return only valid JSON with keys: verdict, confidenceAdjustment, summary, keyRisks, suggestions. Verdict must be approve, caution, or reject. confidenceAdjustment must be a number from -0.2 to 0.2.",
      },
      {
        role: "user",
        content: JSON.stringify(payload, null, 2),
      },
    ],
  });

  const content = completion.choices[0]?.message?.content?.trim() || "";
  const parsed = safeJsonParse(content);
  if (!parsed) {
    return {
      enabled: true,
      model,
      verdict: "caution",
      confidenceAdjustment: -0.02,
      summary: "OpenAI returned an unreadable review payload.",
      keyRisks: ["Unparseable response"],
      suggestions: ["Review the model output manually before enabling strict enforcement."],
    };
  }

  const verdict = normalizeVerdict(parsed.verdict);
  const confidenceAdjustment = clamp(Number(parsed.confidenceAdjustment ?? 0), -0.2, 0.2);

  return {
    enabled: true,
    model,
    verdict,
    confidenceAdjustment,
    summary: String(parsed.summary ?? "").trim() || "No summary provided.",
    keyRisks: toStringArray(parsed.keyRisks),
    suggestions: toStringArray(parsed.suggestions),
  };
}

export function blendOpenAIConfidence(baseConfidence: number, review: OpenAIReview | null): number {
  if (!review) return baseConfidence;

  const reviewWeight = getReviewWeight();
  const verdictBias = review.verdict === "approve" ? 0.03 : review.verdict === "reject" ? -0.05 : 0;
  const adjusted = baseConfidence + (review.confidenceAdjustment * reviewWeight) + verdictBias;
  return clamp(adjusted, 0, 1);
}
