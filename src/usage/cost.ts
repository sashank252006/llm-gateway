import { loadPrices } from '../config/prices.js';

export function computeCost(
  _provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number | null {
  const prices = loadPrices();
  const price = prices[model];
  if (!price) return null;

  const cost =
    (inputTokens / 1_000_000) * price.input +
    (outputTokens / 1_000_000) * price.output;

  return Math.round(cost * 1e8) / 1e8;
}

