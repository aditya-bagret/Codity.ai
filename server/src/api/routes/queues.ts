import { Router } from "express";
import { pool, q, qOne } from "../../db/pool";
import { ApiError } from "../../lib/errors";
import { queueStats } from "../../core/stats";
import { getQueueChecked, requireProjectRole } from "../access";
import { ah, validate } from "../middleware";
import { createQueueBody, patchQueueBody } from "../schemas";

export const queuesRouter = Router();

/** Ensures a retry policy id (when given) belongs to the same project. */
async function assertPolicyInProject(policyId: string | null | undefined, projectId: string): Promise<void> {
  if (!policyId) return;
  const policy = await qOne(pool, "SELECT id FROM retry_policies WHERE id = $1 AND project_id = $2", [
    policyId,
    projectId,
  ]);
  if (!policy) throw ApiError.validation("retryPolicyId does not belong to this project");
}

queuesRouter.get(
  "/projects/:projectId/queues",
  ah(async (req, res) => {
    await requireProjectRole(pool, req.auth, req.params.projectId, "member");
    const data = await q(
      pool,
      `SELECT q.*,
         rp.name AS retry_policy_name,
         count(j.id) FILTER (WHERE j.status = 'queued')::int AS queued,
         count(j.id) FILTER (WHERE j.status IN ('claimed', 'running'))::int AS running,
         count(j.id) FILTER (WHERE j.status = 'scheduled')::int AS scheduled
       FROM queues q
       LEFT JOIN retry_policies rp ON rp.id = q.retry_policy_id
       LEFT JOIN jobs j ON j.queue_id = q.id
       WHERE q.project_id = $1
       GROUP BY q.id, rp.name
       ORDER BY q.priority DESC, q.name`,
      [req.params.projectId],
    );
    res.json({ data });
  }),
);

queuesRouter.post(
  "/projects/:projectId/queues",
  validate(createQueueBody),
  ah(async (req, res) => {
    await requireProjectRole(pool, req.auth, req.params.projectId, "admin");
    const b = req.body as {
      name: string;
      description?: string;
      priority: number;
      maxConcurrency: number;
      rateLimitPerSec?: number | null;
      defaultTimeoutMs: number;
      retryPolicyId?: string | null;
    };
    await assertPolicyInProject(b.retryPolicyId, req.params.projectId);
    const queue = (
      await q(
        pool,
        `INSERT INTO queues (project_id, name, description, priority, max_concurrency,
                             rate_limit_per_sec, default_timeout_ms, retry_policy_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          req.params.projectId,
          b.name,
          b.description ?? null,
          b.priority,
          b.maxConcurrency,
          b.rateLimitPerSec ?? null,
          b.defaultTimeoutMs,
          b.retryPolicyId ?? null,
        ],
      )
    )[0];
    res.status(201).json({ queue });
  }),
);

queuesRouter.get(
  "/queues/:queueId",
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "member");
    const policy = queue.retryPolicyId
      ? await qOne(pool, "SELECT * FROM retry_policies WHERE id = $1", [queue.retryPolicyId])
      : null;
    res.json({ queue, retryPolicy: policy });
  }),
);

queuesRouter.patch(
  "/queues/:queueId",
  validate(patchQueueBody),
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "admin");
    const b = req.body as Record<string, unknown>;
    if ("retryPolicyId" in b) {
      await assertPolicyInProject(b.retryPolicyId as string | null, queue.projectId);
    }

    // Explicit allow-list of updatable columns.
    const columnFor: Record<string, string> = {
      name: "name",
      description: "description",
      priority: "priority",
      maxConcurrency: "max_concurrency",
      rateLimitPerSec: "rate_limit_per_sec",
      defaultTimeoutMs: "default_timeout_ms",
      retryPolicyId: "retry_policy_id",
    };
    const sets: string[] = [];
    const params: unknown[] = [queue.id];
    for (const [field, column] of Object.entries(columnFor)) {
      if (field in b) {
        params.push(b[field]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const updated = (
      await q(pool, `UPDATE queues SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params)
    )[0];
    res.json({ queue: updated });
  }),
);

queuesRouter.post(
  "/queues/:queueId/pause",
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "admin");
    const updated = (
      await q(pool, "UPDATE queues SET is_paused = true WHERE id = $1 RETURNING *", [queue.id])
    )[0];
    res.json({ queue: updated });
  }),
);

queuesRouter.post(
  "/queues/:queueId/resume",
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "admin");
    const updated = (
      await q(pool, "UPDATE queues SET is_paused = false WHERE id = $1 RETURNING *", [queue.id])
    )[0];
    res.json({ queue: updated });
  }),
);

queuesRouter.delete(
  "/queues/:queueId",
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "admin");
    const active = await qOne<{ n: number }>(
      pool,
      "SELECT count(*)::int AS n FROM jobs WHERE queue_id = $1 AND status IN ('claimed', 'running')",
      [queue.id],
    );
    if ((active?.n ?? 0) > 0) {
      throw ApiError.conflict("queue has running jobs; pause it and wait for them to finish first");
    }
    await pool.query("DELETE FROM queues WHERE id = $1", [queue.id]);
    res.json({ deleted: true });
  }),
);

queuesRouter.get(
  "/queues/:queueId/stats",
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "member");
    res.json(await queueStats(pool, queue.id));
  }),
);
