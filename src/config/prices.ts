import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { PricesConfigSchema } from '../domain/schemas.js';
import { env } from './env.js';

export interface PriceEntry {
  input: number;
  output: number;
}

let _prices: Record<string, PriceEntry> | null = null;

export function loadPrices(): Record<string, PriceEntry> {
  if (_prices) return _prices;
  const raw = readFileSync(env.PRICES_CONFIG_PATH, 'utf-8');
  const parsed = load(raw);
  const result = PricesConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.error('Invalid prices configuration:', result.error.flatten());
    process.exit(1);
  }
  _prices = result.data.models;
  return _prices;
}
