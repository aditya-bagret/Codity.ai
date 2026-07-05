import type { RetryStrategy } from "../types";

export interface RetrySnapshot {
  strategy: RetryStrategy;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

/** Platform fallback when neither the queue nor the job specifies a policy. */
export const DEFAULT_RETRY = {
  strategy: "exponential" as RetryStrategy,
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  jitter: true,
};

/**
 * Delay before the next attempt, given the attempt that just failed (1-based).
 *
 *   fixed:        base
 *   linear:       base * attempt
 *   exponential:  base * 2^(attempt - 1)
 *
 * Capped at maxDelayMs; optional ±15% jitter prevents retry stampedes when
 * many jobs fail together (e.g. a downstream outage ending).
 */
export function computeBackoffMs(
  snapshot: RetrySnapshot,
  attempt: number,
  rand: () => number = Math.random,
): number {
  const n = Math.max(1, attempt);
  let delay: number;
  switch (snapshot.strategy) {
    case "fixed":
      delay = snapshot.baseDelayMs;
      break;
    case "linear":
      delay = snapshot.baseDelayMs * n;
      break;
    case "exponential":
      delay = snapshot.baseDelayMs * 2 ** (n - 1);
      break;
  }
  delay = Math.min(delay, snapshot.maxDelayMs);
  if (snapshot.jitter) {
    delay = delay * (0.85 + rand() * 0.3);
  }
  return Math.max(0, Math.round(delay));
}
