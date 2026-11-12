export function exponentialBackoffMs(
  attempt: number, // 0-indexed
  baseMs = 500,
  maxMs = 10000,
  jitter = true
): number {
  const exp = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  if (!jitter) return exp;
  // Full jitter: random between 0 and exp
  return Math.random() * exp;
}
