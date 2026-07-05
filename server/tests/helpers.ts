import { randomUUID } from "node:crypto";
import { afterAll, beforeEach } from "vitest";
import { closePool, pool, q, qOne } from "../src/db/pool";
import type { Queue, RetryPolicy, WorkerRow } from "../src/types";

/** Wipes all data between tests and closes the pool when the file finishes. */
export function useDb(): void {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await closePool();
  });
}

export async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE users, organizations, organization_members, projects, retry_policies,
       queues, workers, worker_heartbeats, job_batches, scheduled_jobs, jobs,
       job_executions, job_logs, dead_letter_jobs
     RESTART IDENTITY CASCADE`,
  );
}

export interface TestContext {
  userId: string;
  orgId: string;
  projectId: string;
  apiKey: string;
  queue: Queue;
}

export interface QueueOverrides {
  name?: string;
  priority?: number;
  maxConcurrency?: number;
  rateLimitPerSec?: number | null;
  retryPolicyId?: string | null;
  isPaused?: boolean;
  defaultTimeoutMs?: number;
}

/** Direct-SQL fixture: user + org + project + one queue. */
export async function seedContext(queueOverrides: QueueOverrides = {}): Promise<TestContext> {
  const user = await qOne<{ id: string }>(
    pool,
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'x', 'Test User') RETURNING id`,
    [`user-${randomUUID().slice(0, 8)}@test.dev`],
  );
  const org = await qOne<{ id: string }>(
    pool,
    "INSERT INTO organizations (name) VALUES ('Test Org') RETURNING id",
  );
  await pool.query(
    "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
    [org!.id, user!.id],
  );
  const apiKey = "ck_test_" + randomUUID().replace(/-/g, "");
  const project = await qOne<{ id: string }>(
    pool,
    "INSERT INTO projects (organization_id, name, api_key) VALUES ($1, 'Test Project', $2) RETURNING id",
    [org!.id, apiKey],
  );
  const queue = await mkQueue(project!.id, queueOverrides);
  return { userId: user!.id, orgId: org!.id, projectId: project!.id, apiKey, queue };
}

export async function mkQueue(projectId: string, overrides: QueueOverrides = {}): Promise<Queue> {
  const rows = await q<Queue>(
    pool,
    `INSERT INTO queues (project_id, name, priority, max_concurrency, rate_limit_per_sec,
                         retry_policy_id, is_paused, default_timeout_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      projectId,
      overrides.name ?? `queue-${randomUUID().slice(0, 8)}`,
      overrides.priority ?? 0,
      overrides.maxConcurrency ?? 100,
      overrides.rateLimitPerSec ?? null,
      overrides.retryPolicyId ?? null,
      overrides.isPaused ?? false,
      overrides.defaultTimeoutMs ?? 60_000,
    ],
  );
  return rows[0];
}

export async function mkRetryPolicy(
  projectId: string,
  opts: Partial<Pick<RetryPolicy, "strategy" | "maxRetries" | "baseDelayMs" | "maxDelayMs" | "jitter">> = {},
): Promise<RetryPolicy> {
  const rows = await q<RetryPolicy>(
    pool,
    `INSERT INTO retry_policies (project_id, name, strategy, max_retries, base_delay_ms, max_delay_ms, jitter)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      projectId,
      `policy-${randomUUID().slice(0, 8)}`,
      opts.strategy ?? "fixed",
      opts.maxRetries ?? 1,
      opts.baseDelayMs ?? 100,
      opts.maxDelayMs ?? 1000,
      opts.jitter ?? false,
    ],
  );
  return rows[0];
}

export async function registerTestWorker(name = "test-worker"): Promise<WorkerRow> {
  const rows = await q<WorkerRow>(
    pool,
    `INSERT INTO workers (id, name, hostname, pid, max_concurrency)
     VALUES ($1, $2, 'test-host', 1, 100) RETURNING *`,
    [randomUUID(), name],
  );
  return rows[0];
}

export async function jobRow<T = Record<string, unknown>>(jobId: string): Promise<T> {
  const row = await qOne<T>(pool, "SELECT * FROM jobs WHERE id = $1", [jobId]);
  if (!row) throw new Error(`job ${jobId} not found`);
  return row;
}

/** Polls `fn` until it returns truthy or the deadline passes. */
export async function eventually<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 10_000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result as T;
    if (Date.now() > deadline) throw new Error("eventually(): condition not met in time");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
