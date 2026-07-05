import { Router } from "express";
import { pool, q, qOne, withTx } from "../../db/pool";
import { ApiError } from "../../lib/errors";
import {
  cancelJob,
  createBatch,
  createJob,
  retryJobNow,
  type BatchJobInput,
} from "../../core/jobs";
import { batchProgress } from "../../core/stats";
import { getJobChecked, getQueueChecked, requireProjectRole } from "../access";
import { ah, page, validate } from "../middleware";
import { createBatchBody, createJobBody, listJobsQuery, retryJobBody } from "../schemas";

export const jobsRouter = Router();

/** Validates a retry policy override against the queue's project. */
async function checkPolicyOverride(retryPolicyId: string | undefined, projectId: string): Promise<void> {
  if (!retryPolicyId) return;
  const policy = await qOne(pool, "SELECT id FROM retry_policies WHERE id = $1 AND project_id = $2", [
    retryPolicyId,
    projectId,
  ]);
  if (!policy) throw ApiError.validation("retryPolicyId does not belong to this project");
}

jobsRouter.post(
  "/queues/:queueId/jobs",
  validate(createJobBody),
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "member");
    const b = req.body as {
      type: string;
      payload?: unknown;
      priority: number;
      delayMs?: number;
      runAt?: Date;
      retries?: number;
      retryPolicyId?: string;
      timeoutMs?: number;
      idempotencyKey?: string;
    };
    await checkPolicyOverride(b.retryPolicyId, queue.projectId);
    const runAt =
      b.runAt ?? (b.delayMs !== undefined ? new Date(Date.now() + b.delayMs) : undefined);
    const { job, deduped } = await withTx((tx) =>
      createJob(tx, queue, {
        type: b.type,
        payload: b.payload,
        priority: b.priority,
        runAt,
        retries: b.retries,
        retryPolicyId: b.retryPolicyId,
        timeoutMs: b.timeoutMs,
        idempotencyKey: b.idempotencyKey,
        createdBy: req.auth.userId ?? undefined,
      }),
    );
    res.status(deduped ? 200 : 201).json({ job, deduped });
  }),
);

jobsRouter.post(
  "/queues/:queueId/jobs/batch",
  validate(createBatchBody),
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "member");
    const b = req.body as { name?: string; jobs: BatchJobInput[] };
    for (const j of b.jobs) await checkPolicyOverride(j.retryPolicyId, queue.projectId);
    const { batch, jobs } = await withTx((tx) =>
      createBatch(tx, queue, b.name ?? null, b.jobs, req.auth.userId ?? undefined),
    );
    res.status(201).json({ batch, created: jobs.length, requested: b.jobs.length, jobs });
  }),
);

jobsRouter.get(
  "/queues/:queueId/jobs",
  validate(listJobsQuery, "query"),
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "member");
    const { limit, offset, status, type, search } = req.query as unknown as {
      limit: number;
      offset: number;
      status?: string[];
      type?: string;
      search?: string;
    };

    const params: unknown[] = [queue.id];
    let where = "queue_id = $1";
    if (status && status.length > 0) {
      params.push(status);
      where += ` AND status = ANY($${params.length}::job_status[])`;
    }
    if (type) {
      params.push(type);
      where += ` AND type = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (id::text ILIKE $${params.length} OR type ILIKE $${params.length} OR idempotency_key ILIKE $${params.length})`;
    }

    const total = await qOne<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM jobs WHERE ${where}`,
      params,
    );
    params.push(limit, offset);
    const data = await q(
      pool,
      `SELECT id, queue_id, type, status, priority, attempts, max_attempts, progress,
              run_at, created_at, started_at, completed_at, last_error, batch_id,
              scheduled_job_id, idempotency_key, claimed_by
       FROM jobs WHERE ${where}
       ORDER BY created_at DESC, id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(page(data, total?.n ?? 0, limit, offset));
  }),
);

jobsRouter.get(
  "/jobs/:jobId",
  ah(async (req, res) => {
    const { job, queueName } = await getJobChecked(pool, req.auth, req.params.jobId, "member");
    const executions = await q(
      pool,
      `SELECT e.*, w.name AS worker_name
       FROM job_executions e LEFT JOIN workers w ON w.id = e.worker_id
       WHERE e.job_id = $1 ORDER BY e.attempt`,
      [job.id],
    );
    const dlq = await qOne(
      pool,
      "SELECT * FROM dead_letter_jobs WHERE job_id = $1 ORDER BY failed_at DESC LIMIT 1",
      [job.id],
    );
    const batch = job.batchId ? await batchProgress(pool, job.batchId) : null;
    res.json({ job: { ...job, queueName }, executions, dlq, batch });
  }),
);

jobsRouter.get(
  "/jobs/:jobId/logs",
  ah(async (req, res) => {
    const { job } = await getJobChecked(pool, req.auth, req.params.jobId, "member");
    const data = await q(
      pool,
      "SELECT * FROM job_logs WHERE job_id = $1 ORDER BY id LIMIT 500",
      [job.id],
    );
    res.json({ data });
  }),
);

jobsRouter.post(
  "/jobs/:jobId/cancel",
  ah(async (req, res) => {
    const { job } = await getJobChecked(pool, req.auth, req.params.jobId, "member");
    const cancelled = await withTx((tx) => cancelJob(tx, job.id));
    if (!cancelled) {
      throw ApiError.conflict(`only scheduled or queued jobs can be cancelled (status: ${job.status})`);
    }
    res.json({ job: cancelled });
  }),
);

jobsRouter.post(
  "/jobs/:jobId/retry",
  validate(retryJobBody),
  ah(async (req, res) => {
    const { job } = await getJobChecked(pool, req.auth, req.params.jobId, "member");
    const { extraAttempts } = req.body as { extraAttempts: number };
    const retried = await withTx((tx) =>
      retryJobNow(tx, job.id, { extraAttempts, requestedBy: req.auth.userId ?? undefined }),
    );
    if (!retried) {
      throw ApiError.conflict(
        `only failed, cancelled or completed jobs can be retried (status: ${job.status})`,
      );
    }
    res.json({ job: retried });
  }),
);

jobsRouter.get(
  "/batches/:batchId",
  ah(async (req, res) => {
    const progress = await batchProgress(pool, req.params.batchId);
    if (!progress) throw ApiError.notFound("batch");
    const queue = await qOne<{ projectId: string }>(
      pool,
      "SELECT project_id FROM queues WHERE id = $1",
      [progress.queueId],
    );
    if (!queue) throw ApiError.notFound("batch");
    await requireProjectRole(pool, req.auth, queue.projectId, "member");
    res.json({ batch: progress });
  }),
);
