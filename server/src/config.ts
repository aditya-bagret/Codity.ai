import fs from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader (no dependency). Looks in the package dir and the repo
 * root. Real environment variables always win over .env file values.
 */
function loadDotEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const [, key, raw] = m;
      if (process.env[key] !== undefined) continue;
      process.env[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
    }
    break;
  }
}
loadDotEnv();

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  env: str("NODE_ENV", "development"),
  port: int("PORT", 4000),
  databaseUrl: str(
    "DATABASE_URL",
    "postgres://codity:codity@localhost:5433/codity",
  ),
  jwtSecret: str("JWT_SECRET", "dev-secret-do-not-use-in-production"),
  jwtExpiresDays: int("JWT_EXPIRES_DAYS", 7),
  logLevel: str("LOG_LEVEL", "info"),
  worker: {
    name: str("WORKER_NAME", ""),
    concurrency: int("WORKER_CONCURRENCY", 5),
    pollIntervalMs: int("WORKER_POLL_INTERVAL_MS", 750),
    heartbeatMs: int("WORKER_HEARTBEAT_MS", 5000),
    /** Queue names this worker subscribes to; empty = all queues. */
    queues: str("WORKER_QUEUES", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    drainTimeoutMs: int("WORKER_DRAIN_TIMEOUT_MS", 25_000),
    /** Extra slack added to a job's timeout when computing its lease. */
    leaseGraceMs: int("WORKER_LEASE_GRACE_MS", 15_000),
  },
  scheduler: {
    tickMs: int("SCHEDULER_TICK_MS", 1000),
    /** A worker missing heartbeats for this long is declared dead. */
    deadWorkerAfterMs: int("DEAD_WORKER_AFTER_MS", 20_000),
  },
};
