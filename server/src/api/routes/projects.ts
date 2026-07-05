import { randomBytes } from "node:crypto";
import { Router } from "express";
import { pool, q, qOne } from "../../db/pool";
import { ApiError } from "../../lib/errors";
import { projectOverview } from "../../core/stats";
import { requireOrgRole, requireProjectRole } from "../access";
import { ah, page, validate } from "../middleware";
import { createProjectBody, listDlqQuery, retryPolicyBody, retryPolicyPatch } from "../schemas";
import type { RetryPolicy } from "../../types";

export const projectsRouter = Router();

function newApiKey(): string {
  return "ck_" + randomBytes(24).toString("base64url");
}

projectsRouter.get(
  "/projects",
  ah(async (req, res) => {
    if (!req.auth.userId) {
      // API-key callers see exactly their own project.
      const data = await q(
        pool,
        `SELECT p.id, p.name, p.organization_id, o.name AS organization_name, p.created_at
         FROM projects p JOIN organizations o ON o.id = p.organization_id
         WHERE p.id = $1`,
        [req.auth.apiKeyProjectId],
      );
      return void res.json({ data });
    }
    const data = await q(
      pool,
      `SELECT p.id, p.name, p.organization_id, o.name AS organization_name, m.role, p.created_at,
         (SELECT count(*)::int FROM queues qq WHERE qq.project_id = p.id) AS queue_count
       FROM projects p
       JOIN organizations o ON o.id = p.organization_id
       JOIN organization_members m ON m.organization_id = o.id AND m.user_id = $1
       ORDER BY p.created_at`,
      [req.auth.userId],
    );
    res.json({ data });
  }),
);

projectsRouter.post(
  "/projects",
  validate(createProjectBody),
  ah(async (req, res) => {
    const { organizationId, name } = req.body as { organizationId: string; name: string };
    await requireOrgRole(pool, req.auth, organizationId, "admin");
    const project = (
      await q(
        pool,
        `INSERT INTO projects (organization_id, name, api_key)
         VALUES ($1, $2, $3) RETURNING *`,
        [organizationId, name, newApiKey()],
      )
    )[0];
    res.status(201).json({ project });
  }),
);

projectsRouter.get(
  "/projects/:projectId",
  ah(async (req, res) => {
    const role = await requireProjectRole(pool, req.auth, req.params.projectId, "member");
    const project = await qOne(pool, "SELECT * FROM projects WHERE id = $1", [req.params.projectId]);
    if (!project) throw ApiError.notFound("project");
    // Only admins get to see the API key.
    if (role === "member") (project as Record<string, unknown>).apiKey = null;
    res.json({ project, role });
  }),
);

projectsRouter.delete(
  "/projects/:projectId",
  ah(async (req, res) => {
    await requireProjectRole(pool, req.auth, req.params.projectId, "owner");
    await pool.query("DELETE FROM projects WHERE id = $1", [req.params.projectId]);
    res.json({ deleted: true });
  }),
);

projectsRouter.post(
  "/projects/:projectId/rotate-api-key",
  ah(async (req, res) => {
    await requireProjectRole(pool, req.auth, req.params.projectId, "admin");
    const key = newApiKey();
    await pool.query("UPDATE projects SET api_key = $2 WHERE id = $1", [req.params.projectId, key]);
    res.json({ apiKey: key });
  }),
);

projectsRouter.get(
  "/projects/:projectId/overview",
  ah(async (req, res) => {
    await requireProjectRole(pool, req.auth, req.params.projectId, "member");
    res.json(await projectOverview(pool, req.params.projectId));
  }),
);

/** Project-wide DLQ listing (per-queue listing lives under /queues/:id/dlq). */
projectsRouter.get(
  "/projects/:projectId/dlq",
  validate(listDlqQuery, "query"),
  ah(async (req, res) => {
    await requireProjectRole(pool, req.auth, req.params.projectId, "member");
    const { limit, offset, status } = req.query as unknown as {
      limit: number;
      offset: number;
      status?: string;
    };
    const params: unknown[] = [req.params.projectId];
    let where = "q.project_id = $1";
    if (status) {
      params.push(status);
      where += ` AND d.status = $${params.length}`;
    }
    const total = await qOne<{ n: number }>(
      pool,
      `SELECT count(*)::int AS n FROM dead_letter_jobs d JOIN queues q ON q.id = d.queue_id WHERE ${where}`,
      params,
    );
    params.push(limit, offset);
    const data = await q(
      pool,
      `SELECT d.*, q.name AS queue_name
       FROM dead_letter_jobs d JOIN queues q ON q.id = d.queue_id
       WHERE ${where}
       ORDER BY d.failed_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(page(data, total?.n ?? 0, limit, offset));
  }),
);

// --- retry policies ---------------------------------------------------------

projectsRouter.get(
  "/projects/:projectId/retry-policies",
  ah(async (req, res) => {
    await requireProjectRole(pool, req.auth, req.params.projectId, "member");
    const data = await q(
      pool,
      "SELECT * FROM retry_policies WHERE project_id = $1 ORDER BY created_at",
      [req.params.projectId],
    );
    res.json({ data });
  }),
);

projectsRouter.post(
  "/projects/:projectId/retry-policies",
  validate(retryPolicyBody),
  ah(async (req, res) => {
    await requireProjectRole(pool, req.auth, req.params.projectId, "admin");
    const b = req.body as {
      name: string;
      strategy: string;
      maxRetries: number;
      baseDelayMs: number;
      maxDelayMs: number;
      jitter: boolean;
    };
    const policy = (
      await q(
        pool,
        `INSERT INTO retry_policies (project_id, name, strategy, max_retries, base_delay_ms, max_delay_ms, jitter)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [req.params.projectId, b.name, b.strategy, b.maxRetries, b.baseDelayMs, b.maxDelayMs, b.jitter],
      )
    )[0];
    res.status(201).json({ policy });
  }),
);

projectsRouter.patch(
  "/retry-policies/:policyId",
  validate(retryPolicyPatch),
  ah(async (req, res) => {
    const policy = await qOne<RetryPolicy>(pool, "SELECT * FROM retry_policies WHERE id = $1", [
      req.params.policyId,
    ]);
    if (!policy) throw ApiError.notFound("retry policy");
    await requireProjectRole(pool, req.auth, policy.projectId, "admin");

    const b = req.body as Partial<{
      name: string;
      strategy: string;
      maxRetries: number;
      baseDelayMs: number;
      maxDelayMs: number;
      jitter: boolean;
    }>;
    const merged = {
      name: b.name ?? policy.name,
      strategy: b.strategy ?? policy.strategy,
      maxRetries: b.maxRetries ?? policy.maxRetries,
      baseDelayMs: b.baseDelayMs ?? policy.baseDelayMs,
      maxDelayMs: b.maxDelayMs ?? policy.maxDelayMs,
      jitter: b.jitter ?? policy.jitter,
    };
    if (merged.maxDelayMs < merged.baseDelayMs) {
      throw ApiError.validation("maxDelayMs must be >= baseDelayMs");
    }
    const updated = (
      await q(
        pool,
        `UPDATE retry_policies SET name = $2, strategy = $3, max_retries = $4,
           base_delay_ms = $5, max_delay_ms = $6, jitter = $7
         WHERE id = $1 RETURNING *`,
        [
          policy.id,
          merged.name,
          merged.strategy,
          merged.maxRetries,
          merged.baseDelayMs,
          merged.maxDelayMs,
          merged.jitter,
        ],
      )
    )[0];
    res.json({ policy: updated });
  }),
);

projectsRouter.delete(
  "/retry-policies/:policyId",
  ah(async (req, res) => {
    const policy = await qOne<RetryPolicy>(pool, "SELECT * FROM retry_policies WHERE id = $1", [
      req.params.policyId,
    ]);
    if (!policy) throw ApiError.notFound("retry policy");
    await requireProjectRole(pool, req.auth, policy.projectId, "admin");
    await pool.query("DELETE FROM retry_policies WHERE id = $1", [policy.id]);
    res.json({ deleted: true });
  }),
);
