import type { Db } from "../db/pool";
import { q, qOne } from "../db/pool";
import { computeBackoffMs, DEFAULT_RETRY } from "./retry";
import type {
  Job,
  JobBatch,
  JobExecution,
  JobStatus,
  LogLevel,
  Queue,
  RetryPolicy,
  RetryStrategy,
} from "../types";

/** Failures a concluded execution can report. */
export type FailureKind = "failed" | "timed_out" | "lost";

const FAILURE_VERB: Record<FailureKind, string> = {
  failed: "failed",
  timed_out: "timed out",
  lost: "was lost (worker died or lease expired)",
};

function truncate(s: string, max = 300): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export async function addJobLog(
  db: Db,
  jobId: string,
  level: LogLevel,
  message: string,
  executionId: string | null = null,
): Promise<void> {
  await db.query(
    "INSERT INTO job_logs (job_id, execution_id, level, message) VALUES ($1, $2, $3, $4)",
    [jobId, executionId, level, message],
  );
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface RetryOverrides {
  retries?: number;
  retryPolicyId?: string;
}

export interface ResolvedRetry {
  maxAttempts: number;
  strategy: RetryStrategy;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

/**
 * Resolves the retry configuration snapshot for a new job. Precedence:
 * explicit policy on the request > queue's policy > platform default, with an
 * optional flat `retries` count override on top.
 */
export async function resolveRetry(
  db: Db,
  queue: Queue,
  overrides: RetryOverrides = {},
): Promise<ResolvedRetry> {
  let policy: RetryPolicy | null = null;
  const policyId = overrides.retryPolicyId ?? queue.retryPolicyId;
  if (policyId) {
    policy = await qOne<RetryPolicy>(db, "SELECT * FROM retry_policies WHERE id = $1", [policyId]);
  }
  const base = policy ?? DEFAULT_RETRY;
  const retries = overrides.retries ?? base.maxRetries;
  return {
    maxAttempts: retries + 1,
    strategy: base.strategy,
    baseDelayMs: base.baseDelayMs,
    maxDelayMs: base.maxDelayMs,
    jitter: base.jitter,
  };
}

export interface CreateJobInput extends RetryOverrides {
  type: string;
  payload?: unknown;
  priority?: number;
  runAt?: Date;
  timeoutMs?: number;
  idempotencyKey?: string;
  batchId?: string;
  scheduledJobId?: string;
  createdBy?: string;
}

/**
 * Inserts a job. A future run_at lands it in 'scheduled' (the scheduler
 * promotes it when due); otherwise it is immediately claimable. Idempotency
 * keys dedupe via the partial unique index — the existing job is returned.
 */
export async function createJob(
  db: Db,
  queue: Queue,
  input: CreateJobInput,
): Promise<{ job: Job; deduped: boolean }> {
  const retry = await resolveRetry(db, queue, input);
  const runAt = input.runAt ?? new Date();
  const status: JobStatus = runAt.getTime() > Date.now() + 500 ? "scheduled" : "queued";
  const rows = await q<Job>(
    db,
    `INSERT INTO jobs (
       queue_id, type, payload, priority, status, run_at, max_attempts, timeout_ms,
       retry_strategy, retry_base_delay_ms, retry_max_delay_ms, retry_jitter,
       idempotency_key, batch_id, scheduled_job_id, created_by
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (queue_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      queue.id,
      input.type,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 0,
      status,
      runAt,
      retry.maxAttempts,
      input.timeoutMs ?? queue.defaultTimeoutMs,
      retry.strategy,
      retry.baseDelayMs,
      retry.maxDelayMs,
      retry.jitter,
      input.idempotencyKey ?? null,
      input.batchId ?? null,
      input.scheduledJobId ?? null,
      input.createdBy ?? null,
    ],
  );
  if (rows.length === 0) {
    const existing = await qOne<Job>(
      db,
      "SELECT * FROM jobs WHERE queue_id = $1 AND idempotency_key = $2",
      [queue.id, input.idempotencyKey],
    );
    return { job: existing as Job, deduped: true };
  }
  const job = rows[0];
  await addJobLog(
    db,
    job.id,
    "info",
    status === "scheduled"
      ? `Job created, scheduled for ${runAt.toISOString()}`
      : "Job created and queued",
  );
  return { job, deduped: false };
}

export interface BatchJobInput extends RetryOverrides {
  type: string;
  payload?: unknown;
  priority?: number;
  delayMs?: number;
  timeoutMs?: number;
  idempotencyKey?: string;
}

/** Bulk-inserts a batch of jobs in a single statement. Call inside a transaction. */
export async function createBatch(
  db: Db,
  queue: Queue,
  name: string | null,
  inputs: BatchJobInput[],
  createdBy?: string,
): Promise<{ batch: JobBatch; jobs: Job[] }> {
  const batch = (
    await q<JobBatch>(
      db,
      "INSERT INTO job_batches (queue_id, name, total, created_by) VALUES ($1, $2, $3, $4) RETURNING *",
      [queue.id, name, inputs.length, createdBy ?? null],
    )
  )[0];

  const baseRetry = await resolveRetry(db, queue, {});
  const now = Date.now();
  const items = [];
  for (const input of inputs) {
    const retry =
      input.retries !== undefined || input.retryPolicyId !== undefined
        ? await resolveRetry(db, queue, input)
        : baseRetry;
    const delayMs = input.delayMs ?? 0;
    items.push({
      type: input.type,
      payload: JSON.stringify(input.payload ?? {}),
      priority: input.priority ?? 0,
      status: delayMs > 500 ? "scheduled" : "queued",
      run_at: new Date(now + delayMs).toISOString(),
      max_attempts: retry.maxAttempts,
      timeout_ms: input.timeoutMs ?? queue.defaultTimeoutMs,
      retry_strategy: retry.strategy,
      retry_base_delay_ms: retry.baseDelayMs,
      retry_max_delay_ms: retry.maxDelayMs,
      retry_jitter: retry.jitter,
      idempotency_key: input.idempotencyKey ?? null,
    });
  }

  const jobs = await q<Job>(
    db,
    `INSERT INTO jobs (
       queue_id, batch_id, created_by, type, payload, priority, status, run_at,
       max_attempts, timeout_ms, retry_strategy, retry_base_delay_ms,
       retry_max_delay_ms, retry_jitter, idempotency_key
     )
     SELECT $1, $2, $3, x.type, x.payload::jsonb, x.priority, x.status::job_status,
            x.run_at::timestamptz, x.max_attempts, x.timeout_ms,
            x.retry_strategy::retry_strategy, x.retry_base_delay_ms,
            x.retry_max_delay_ms, x.retry_jitter, x.idempotency_key
     FROM jsonb_to_recordset($4::jsonb) AS x(
       type text, payload text, priority int, status text, run_at text,
       max_attempts int, timeout_ms int, retry_strategy text,
       retry_base_delay_ms int, retry_max_delay_ms int, retry_jitter boolean,
       idempotency_key text
     )
     ON CONFLICT (queue_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [queue.id, batch.id, createdBy ?? null, JSON.stringify(items)],
  );

  await db.query(
    `INSERT INTO job_logs (job_id, level, message)
     SELECT id, 'info', 'Job created in batch ' || $1 FROM jobs WHERE batch_id = $2`,
    [name ?? batch.id, batch.id],
  );

  return { batch, jobs };
}

// ---------------------------------------------------------------------------
// Execution lifecycle (worker + reaper call these)
// ---------------------------------------------------------------------------

/** claimed → running; records the attempt in job_executions. */
export async function startExecution(db: Db, job: Job, workerId: string): Promise<JobExecution> {
  const exec = (
    await q<JobExecution>(
      db,
      "INSERT INTO job_executions (job_id, worker_id, attempt) VALUES ($1, $2, $3) RETURNING *",
      [job.id, workerId, job.attempts + 1],
    )
  )[0];
  await db.query(
    `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, now()), progress = 0
     WHERE id = $1 AND status = 'claimed'`,
    [job.id],
  );
  return exec;
}

/**
 * running → completed. Guarded on the current status: if the reaper already
 * reclaimed this job (lease expired), the transition is skipped and the late
 * result is discarded — at-least-once semantics, documented in the design doc.
 */
export async function completeExecution(
  db: Db,
  job: Job,
  execution: JobExecution,
  result: unknown,
): Promise<{ stolen: boolean }> {
  const resultJson = result === undefined ? null : JSON.stringify(result);
  const updated = await db.query(
    `UPDATE jobs SET status = 'completed', attempts = $2, completed_at = now(),
       result = $3, progress = 100, last_error = NULL, lease_expires_at = NULL
     WHERE id = $1 AND status = 'running'`,
    [job.id, execution.attempt, resultJson],
  );
  const stolen = (updated.rowCount ?? 0) === 0;
  await db.query(
    `UPDATE job_executions SET status = 'succeeded', finished_at = now(),
       duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int, result = $2
     WHERE id = $1 AND status = 'running'`,
    [execution.id, resultJson],
  );
  await addJobLog(
    db,
    job.id,
    stolen ? "warn" : "info",
    stolen
      ? `Attempt ${execution.attempt} finished after its lease expired; result discarded`
      : `Attempt ${execution.attempt} succeeded`,
    execution.id,
  );
  return { stolen };
}

/**
 * running → scheduled (retry with backoff) or → failed (+ DLQ entry) when
 * attempts are exhausted. `lost` failures (dead worker, expired lease) consume
 * an attempt too, which bounds poison jobs that keep killing workers.
 */
export async function failExecution(
  db: Db,
  job: Job,
  execution: JobExecution,
  errorMessage: string,
  kind: FailureKind,
): Promise<{ retryAt: Date | null; dead: boolean; stolen: boolean }> {
  const attempt = execution.attempt;
  const execRes = await db.query(
    `UPDATE job_executions SET status = $2, finished_at = now(),
       duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int, error = $3
     WHERE id = $1 AND status = 'running'`,
    [execution.id, kind, errorMessage],
  );
  if ((execRes.rowCount ?? 0) === 0) {
    return { retryAt: null, dead: false, stolen: true };
  }

  const verb = FAILURE_VERB[kind];

  if (attempt < job.maxAttempts) {
    const delayMs = computeBackoffMs(
      {
        strategy: job.retryStrategy,
        baseDelayMs: job.retryBaseDelayMs,
        maxDelayMs: job.retryMaxDelayMs,
        jitter: job.retryJitter,
      },
      attempt,
    );
    const jobRes = await db.query(
      `UPDATE jobs SET status = 'scheduled', attempts = $2,
         run_at = now() + make_interval(secs => $3::double precision / 1000),
         last_error = $4, claimed_by = NULL, claimed_at = NULL,
         lease_expires_at = NULL, progress = NULL
       WHERE id = $1 AND status IN ('claimed', 'running')
       RETURNING run_at`,
      [job.id, attempt, delayMs, errorMessage],
    );
    if ((jobRes.rowCount ?? 0) === 0) return { retryAt: null, dead: false, stolen: true };
    const retryAt = jobRes.rows[0].run_at as Date;
    await addJobLog(
      db,
      job.id,
      "warn",
      `Attempt ${attempt}/${job.maxAttempts} ${verb}: ${truncate(errorMessage)} — retrying in ${(delayMs / 1000).toFixed(1)}s`,
      execution.id,
    );
    return { retryAt, dead: false, stolen: false };
  }

  const jobRes = await db.query(
    `UPDATE jobs SET status = 'failed', attempts = $2, completed_at = now(),
       last_error = $3, claimed_by = NULL, claimed_at = NULL,
       lease_expires_at = NULL, progress = NULL
     WHERE id = $1 AND status IN ('claimed', 'running')`,
    [job.id, attempt, errorMessage],
  );
  if ((jobRes.rowCount ?? 0) === 0) return { retryAt: null, dead: false, stolen: true };
  await db.query(
    `INSERT INTO dead_letter_jobs (job_id, queue_id, job_type, payload, reason, attempts_made)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [job.id, job.queueId, job.type, JSON.stringify(job.payload ?? {}), `${verb}: ${truncate(errorMessage, 500)}`, attempt],
  );
  await addJobLog(
    db,
    job.id,
    "error",
    `Attempt ${attempt}/${job.maxAttempts} ${verb}: ${truncate(errorMessage)} — moved to dead letter queue`,
    execution.id,
  );
  return { retryAt: null, dead: true, stolen: false };
}

// ---------------------------------------------------------------------------
// User-facing actions
// ---------------------------------------------------------------------------

/** Cancels a job that has not started yet. Returns null if not cancellable. */
export async function cancelJob(db: Db, jobId: string): Promise<Job | null> {
  const rows = await q<Job>(
    db,
    `UPDATE jobs SET status = 'cancelled', completed_at = now()
     WHERE id = $1 AND status IN ('scheduled', 'queued') RETURNING *`,
    [jobId],
  );
  if (rows.length === 0) return null;
  await addJobLog(db, jobId, "info", "Job cancelled");
  return rows[0];
}

/**
 * Manually re-queues a terminal job (failed / cancelled / completed), granting
 * extra attempts on top of those already consumed. Pending DLQ entries for the
 * job are marked retried. Returns null if the job is not in a terminal state.
 */
export async function retryJobNow(
  db: Db,
  jobId: string,
  opts: { extraAttempts?: number; requestedBy?: string } = {},
): Promise<Job | null> {
  const extra = Math.max(1, opts.extraAttempts ?? 1);
  const rows = await q<Job>(
    db,
    `UPDATE jobs SET status = 'queued', run_at = now(), max_attempts = attempts + $2,
       completed_at = NULL, progress = NULL, claimed_by = NULL, claimed_at = NULL,
       lease_expires_at = NULL
     WHERE id = $1 AND status IN ('failed', 'cancelled', 'completed') RETURNING *`,
    [jobId, extra],
  );
  if (rows.length === 0) return null;
  await db.query(
    `UPDATE dead_letter_jobs SET status = 'retried', resolved_at = now(), resolved_by = $2
     WHERE job_id = $1 AND status = 'pending'`,
    [jobId, opts.requestedBy ?? null],
  );
  await addJobLog(db, jobId, "info", `Job manually requeued (${extra} extra attempt(s) granted)`);
  return rows[0];
}

/** Marks a pending DLQ entry discarded. Returns null if already resolved. */
export async function discardDlqEntry(
  db: Db,
  dlqId: string,
  userId?: string,
): Promise<{ id: string } | null> {
  const rows = await q<{ id: string; jobId: string }>(
    db,
    `UPDATE dead_letter_jobs SET status = 'discarded', resolved_at = now(), resolved_by = $2
     WHERE id = $1 AND status = 'pending' RETURNING id, job_id`,
    [dlqId, userId ?? null],
  );
  if (rows.length === 0) return null;
  await addJobLog(db, rows[0].jobId, "info", "Dead letter entry discarded");
  return rows[0];
}
