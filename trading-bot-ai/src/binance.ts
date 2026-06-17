import crypto from "node:crypto";
import { Candle } from "./types";

export interface BinanceAccountBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface BinanceAccountResponse {
  makerCommission: number;
  takerCommission: number;
  buyerCommission: number;
  sellerCommission: number;
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  brokered: boolean;
  requireSelfTradePrevention: boolean;
  updateTime: number;
  accountType: string;
  balances: BinanceAccountBalance[];
  permissions?: string[];
}

export interface BinanceOrderTestRequest {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity: string;
  timeInForce?: "GTC";
  price?: string;
  recvWindow?: number;
}

export interface BinanceSpotClientOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
}

function encodeParams(params: Record<string, string | number | boolean | undefined | null>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function normalizeInterval(interval: string): string {
  return interval.trim();
}

export class BinanceSpotClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(options: BinanceSpotClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey.trim();
    this.apiSecret = options.apiSecret.trim();
  }

  private sign(query: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(query).digest("hex");
  }

  private async request<T>(
    path: string,
    init: {
      method: "GET" | "POST" | "DELETE";
      params?: Record<string, string | number | boolean | undefined | null>;
      signed?: boolean;
    },
  ): Promise<T> {
    const timestamp = Date.now();
    const params = { ...(init.params ?? {}) };
    if (init.signed) {
      params.timestamp = timestamp;
      params.recvWindow = params.recvWindow ?? 5000;
    }

    const query = encodeParams(params);
    const signature = init.signed ? this.sign(query) : "";
    const url = `${this.baseUrl}${path}${query ? `?${query}${init.signed ? `&signature=${signature}` : ""}` : ""}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (init.signed) {
      headers["X-MBX-APIKEY"] = this.apiKey;
    }

    const response = await fetch(url, {
      method: init.method,
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Binance request failed (${response.status}): ${text}`);
    }

    return (await response.json()) as T;
  }

  async getKlines(symbol: string, interval: string, limit = 240): Promise<Candle[]> {
    const data = await this.request<any[]>("/api/v3/klines", {
      method: "GET",
      params: {
        symbol,
        interval: normalizeInterval(interval),
        limit,
      },
    });

    return data.map((entry) => ({
      timestamp: Number(entry[6]),
      open: Number(entry[1]),
      high: Number(entry[2]),
      low: Number(entry[3]),
      close: Number(entry[4]),
      volume: Number(entry[5]),
    }));
  }

  async getAccount(): Promise<BinanceAccountResponse> {
    return this.request<BinanceAccountResponse>("/api/v3/account", {
      method: "GET",
      signed: true,
    });
  }

  async testOrder(request: BinanceOrderTestRequest): Promise<unknown> {
    return this.request<unknown>("/api/v3/order/test", {
      method: "POST",
      signed: true,
      params: {
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        quantity: request.quantity,
        timeInForce: request.timeInForce,
        price: request.price,
        recvWindow: request.recvWindow ?? 5000,
      },
    });
  }

  async placeOrder(request: BinanceOrderTestRequest): Promise<unknown> {
    return this.request<unknown>("/api/v3/order", {
      method: "POST",
      signed: true,
      params: {
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        quantity: request.quantity,
        timeInForce: request.timeInForce,
        price: request.price,
        recvWindow: request.recvWindow ?? 5000,
      },
    });
  }
}
