import { Router } from "express";
import { pool } from "../../db/pool";
import { ApiError } from "../../lib/errors";
import { getWorkerDetail, listWorkers } from "../../core/workers";
import { ah } from "../middleware";

/**
 * Workers are platform infrastructure (they serve every project), so any
 * authenticated user may inspect them. They contain no tenant data beyond
 * job ids, which are authorized separately when opened.
 */
export const workersRouter = Router();

workersRouter.get(
  "/workers",
  ah(async (_req, res) => {
    res.json({ data: await listWorkers(pool) });
  }),
);

workersRouter.get(
  "/workers/:workerId",
  ah(async (req, res) => {
    const detail = await getWorkerDetail(pool, req.params.workerId);
    if (!detail) throw ApiError.notFound("worker");
    res.json(detail);
  }),
);
