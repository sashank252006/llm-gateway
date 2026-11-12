import type { RouteAlias } from '../domain/types.js';
import { loadRouteConfig } from '../config/routing.js';
import { GatewayError } from '../domain/errors.js';

export function resolveAlias(alias: string): RouteAlias {
  const config = loadRouteConfig();
  const route = config.aliases[alias];
  if (!route) {
    throw new GatewayError('model_not_found', `Unknown model alias: ${alias}`);
  }
  return route;
}

export function getAliases(): string[] {
  return Object.keys(loadRouteConfig().aliases);
}
