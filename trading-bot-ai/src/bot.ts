import { AdaptiveCoach } from "./ai";
import { BotConfig, BotDecision, MarketContext, PortfolioState, PositionPlan, Signal, TradeRecord } from "./types";
import { scoreDirection } from "./market";
import { clamp } from "./utils";

export class RiskManager {
  constructor(private readonly config: BotConfig) {}

  assess(
    signal: Signal,
    context: MarketContext,
    state: PortfolioState,
    riskMultiplier: number,
    gates?: { newsBlocked?: boolean; newsReasons?: string[] },
  ): { allowed: boolean; reasons: string[]; plan?: PositionPlan } {
    if (state.halted) return { allowed: false, reasons: ["Trading halted"] };
    if (state.openPositions >= this.config.maxOpenPositions) {
      return { allowed: false, reasons: ["Max positions reached"] };
    }
    if (state.cooldownBars > 0) {
      return { allowed: false, reasons: [`Cooldown ${state.cooldownBars} bars`] };
    }

    if (gates?.newsBlocked) {
      return {
        allowed: false,
        reasons: ["News blackout", ...(gates.newsReasons ?? [])],
      };
    }

    const mid = (context.book.bestBid + context.book.bestAsk) / 2;
    const spreadPct = (context.book.bestAsk - context.book.bestBid) / mid;

    if (spreadPct > this.config.maxSpreadPct) {
      return { allowed: false, reasons: ["Spread too wide"] };
    }

    if (state.sessionPnl <= -state.equity * this.config.maxDailyLossPct) {
      return { allowed: false, reasons: ["Daily loss limit"] };
    }

    if (state.equity <= state.peakEquity * (1 - this.config.maxDrawdownPct)) {
      return { allowed: false, reasons: ["Drawdown limit"] };
    }

    const stopDistance = Math.abs(signal.entry - signal.stopLoss);
    const confidenceMultiplier = clamp(0.75 + signal.confidence * 0.5, 0.75, 1.25);
    const riskBudget = state.equity * this.config.riskPerTrade * confidenceMultiplier * riskMultiplier;

    const unitsByRisk = Math.floor(
      riskBudget / Math.max(stopDistance + this.config.commissionPerUnit, 1e-9)
    );

    const unitsByNotional = Math.floor(
      (state.equity * this.config.maxPositionNotionalPct) / Math.max(signal.entry, 1)
    );

    const units = Math.max(0, Math.min(unitsByRisk, unitsByNotional));

    if (units < 1) {
      return {
        allowed: false,
        reasons: [
          "Position size too small",
          `Risk budget ${riskBudget.toFixed(2)}`,
          `Stop distance ${stopDistance.toFixed(2)}`,
          `Units by risk ${unitsByRisk}`,
          `Units by notional ${unitsByNotional}`
        ]
      };
    }

    return {
      allowed: true,
      reasons: [
        `Risk budget ${riskBudget.toFixed(2)}`,
        `Units ${units}`,
        `Spread ${(spreadPct * 100).toFixed(3)}%`
      ],
      plan: {
        symbol: context.symbol,
        side: signal.side,
        units,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        confidence: signal.confidence,
        riskAmount: units * stopDistance,
      },
    };
  }
}

export class PaperBroker {
  constructor(private readonly config: BotConfig) {}

  fillEntry(plan: PositionPlan, context: MarketContext) {
    const mid = (context.book.bestBid + context.book.bestAsk) / 2;
    const spread = context.book.bestAsk - context.book.bestBid;
    const slip = mid * (this.config.slippageBps / 10000) + spread * 0.1;
    const price = plan.side === "buy" ? context.book.bestAsk + slip : context.book.bestBid - slip;
    return {
      symbol: plan.symbol,
      side: plan.side,
      units: plan.units,
      price,
      commission: plan.units * this.config.commissionPerUnit,
      timestamp: context.timestamp
    };
  }

  fillExit(plan: PositionPlan, context: MarketContext) {
    const mid = (context.book.bestBid + context.book.bestAsk) / 2;
    const spread = context.book.bestAsk - context.book.bestBid;
    const slip = mid * (this.config.slippageBps / 10000) + spread * 0.1;
    const side = plan.side === "buy" ? "sell" : "buy";
    const price = side === "buy" ? context.book.bestAsk + slip : context.book.bestBid - slip;
    return {
      symbol: plan.symbol,
      side,
      units: plan.units,
      price,
      commission: plan.units * this.config.commissionPerUnit,
      timestamp: context.timestamp
    };
  }
}

export class TradingBot {
  constructor(
    private readonly config: BotConfig,
    private readonly coach: AdaptiveCoach,
    private readonly risk: RiskManager,
    private readonly broker: PaperBroker,
  ) {}

  evaluate(
    context: MarketContext,
    state: PortfolioState,
    gates?: { newsBlocked?: boolean; newsReasons?: string[] },
  ): BotDecision {
    const buy = scoreDirection(
      "buy",
      context,
      this.config.trendFast,
      this.config.trendSlow,
      this.config.minVolumeRatio,
      this.config.maxSpreadPct,
      this.config.stopAtrMultiple,
      this.config.targetAtrMultiple
    );

    const sell = scoreDirection(
      "sell",
      context,
      this.config.trendFast,
      this.config.trendSlow,
      this.config.minVolumeRatio,
      this.config.maxSpreadPct,
      this.config.stopAtrMultiple,
      this.config.targetAtrMultiple
    );

    const snapshot = {
      candidates: [buy.candidate, sell.candidate],
      diagnostics: [`Market structure ready`, `Base candles: ${context.candles.length}`],
    };

    const chosen = this.coach.select(snapshot);

    if (!chosen.signal) {
      return { action: "hold", reasons: chosen.diagnostics };
    }

    const assessment = this.risk.assess(
      chosen.signal,
      context,
      state,
      this.coach.getState().riskMultiplier,
      gates,
    );

    if (!assessment.allowed || !assessment.plan) {
      return {
        action: "blocked",
        reasons: [...chosen.diagnostics, ...assessment.reasons],
        signal: chosen.signal,
        modelScore: chosen.modelScore
      };
    }

    return {
      action: chosen.signal.side === "buy" ? "enter-long" : "enter-short",
      reasons: [...chosen.diagnostics, ...assessment.reasons],
      signal: chosen.signal,
      plan: assessment.plan,
      modelScore: chosen.modelScore,
    };
  }

  learn(trade: TradeRecord) {
    this.coach.learn(trade);
  }

  getBroker() {
    return this.broker;
  }

  getModelState() {
    return this.coach.getState();
  }
}
