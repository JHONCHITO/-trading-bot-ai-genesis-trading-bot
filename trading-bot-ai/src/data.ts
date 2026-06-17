import { Candle } from "./types";

function rand(seed: number): () => number {
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  return () => {
    x = (x * 16807) % 2147483647;
    return (x - 1) / 2147483646;
  };
}

export function generateSyntheticCandles(count = 240, startPrice = 100): Candle[] {
  const r = rand(19);
  const out: Candle[] = [];
  let prev = startPrice;
  const start = Date.UTC(2026, 0, 1, 13, 30, 0);

  for (let i = 0; i < count; i += 1) {
    const regime = Math.floor(i / 60) % 3;
    const drift = regime === 0 ? 0.34 : regime === 1 ? -0.26 : 0.3;
    const noise = (r() - 0.5) * 0.7;
    const seasonal = Math.sin(i / 9) * 0.1;
    const open = prev;
    const close = Math.max(1, open + drift + noise + seasonal);
    const wick = Math.abs(noise) * 0.5 + 0.15 + r() * 0.16;
    const high = Math.max(open, close) + wick;
    const low = Math.max(0.5, Math.min(open, close) - wick);
    const volume = Math.round(950 + regime * 170 + Math.abs(noise) * 220 + r() * 140);
    const timestamp = start + i * 60_000;
    out.push({ time: timestamp, timestamp, open, high, low, close, volume });
    prev = close;
  }
  return out;
}
