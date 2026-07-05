import { Router } from "express";
import { pool, q, qOne, withTx } from "../../db/pool";
import { ApiError } from "../../lib/errors";
import { discardDlqEntry, retryJobNow } from "../../core/jobs";
import { getQueueChecked, requireProjectRole } from "../access";
import { ah, page, validate } from "../middleware";
import { listDlqQuery } from "../schemas";
import type { DeadLetterJob } from "../../types";

export const dlqRouter = Router();

async function getDlqChecked(
  auth: { userId: string | null; apiKeyProjectId: string | null },
  dlqId: string,
  min: "member" | "admin",
): Promise<DeadLetterJob> {
  const entry = await qOne<DeadLetterJob>(pool, "SELECT * FROM dead_letter_jobs WHERE id = $1", [
    dlqId,
  ]);
  if (!entry) throw ApiError.notFound("dead letter entry");
  const queue = await qOne<{ projectId: string }>(
    pool,
    "SELECT project_id FROM queues WHERE id = $1",
    [entry.queueId],
  );
  if (!queue) throw ApiError.notFound("dead letter entry");
  await requireProjectRole(pool, auth, queue.projectId, min);
  return entry;
}

dlqRouter.get(
  "/queues/:queueId/dlq",
  validate(listDlqQuery, "query"),
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "member");
    const { limit, offset, status } = req.query as unknown as {
      limit: number;
      offset: number;
      status?: string;
    };
    const params: unknown[] = [queue.id];
    let where = "queue_id = $1";
    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    const total = await qOne<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM dead_letter_jobs WHERE ${where}`,
      params,
    );
    params.push(limit, offset);
    const data = await q(
      pool,
      `SELECT * FROM dead_letter_jobs WHERE ${where}
       ORDER BY failed_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(page(data, total?.n ?? 0, limit, offset));
  }),
);

/** Re-drive one DLQ entry: the underlying job goes back to 'queued'. */
dlqRouter.post(
  "/dlq/:dlqId/retry",
  ah(async (req, res) => {
    const entry = await getDlqChecked(req.auth, req.params.dlqId, "member");
    if (entry.status !== "pending") {
      throw ApiError.conflict(`entry already ${entry.status}`);
    }
    const job = await withTx((tx) =>
      retryJobNow(tx, entry.jobId, { requestedBy: req.auth.userId ?? undefined }),
    );
    if (!job) throw ApiError.conflict("underlying job is not in a retryable state");
    res.json({ job });
  }),
);

dlqRouter.post(
  "/dlq/:dlqId/discard",
  ah(async (req, res) => {
    const entry = await getDlqChecked(req.auth, req.params.dlqId, "admin");
    const result = await discardDlqEntry(pool, entry.id, req.auth.userId ?? undefined);
    if (!result) throw ApiError.conflict("entry already resolved");
    res.json({ discarded: true });
  }),
);

/** Bulk re-drive of every pending entry in a queue. */
dlqRouter.post(
  "/queues/:queueId/dlq/retry-all",
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "admin");
    const pending = await q<{ id: string; jobId: string }>(
      pool,
      "SELECT id, job_id FROM dead_letter_jobs WHERE queue_id = $1 AND status = 'pending'",
      [queue.id],
    );
    let retried = 0;
    for (const entry of pending) {
      const job = await withTx((tx) =>
        retryJobNow(tx, entry.jobId, { requestedBy: req.auth.userId ?? undefined }),
      );
      if (job) retried++;
    }
    res.json({ retried, total: pending.length });
  }),
);
