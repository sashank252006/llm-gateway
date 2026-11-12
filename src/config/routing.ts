import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { RouteConfigSchema } from '../domain/schemas.js';
import type { RouteConfig } from '../domain/types.js';
import { env } from './env.js';

let _config: RouteConfig | null = null;

export function loadRouteConfig(): RouteConfig {
  if (_config) return _config;
  const raw = readFileSync(env.ROUTE_CONFIG_PATH, 'utf-8');
  const parsed = load(raw);
  const result = RouteConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.error('Invalid routing configuration:', result.error.flatten());
    process.exit(1);
  }
  _config = result.data as RouteConfig;
  return _config;
}
