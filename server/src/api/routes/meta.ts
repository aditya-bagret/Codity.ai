import { Router } from "express";
import { pool } from "../../db/pool";
import { jobTypes } from "../../jobs/handlers";
import { ah } from "../middleware";

export const metaRouter = Router();

metaRouter.get(
  "/health",
  ah(async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", db: "up" });
    } catch {
      res.status(503).json({ status: "degraded", db: "down" });
    }
  }),
);

/** Registered job types (drives the dashboard's create-job form). */
metaRouter.get("/meta", (_req, res) => {
  res.json({
    jobTypes: jobTypes.map(({ type, description, samplePayload }) => ({
      type,
      description,
      samplePayload,
    })),
  });
});
