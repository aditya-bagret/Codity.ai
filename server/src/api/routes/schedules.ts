import { Router } from "express";
import { pool, q, qOne, withTx } from "../../db/pool";
import { ApiError } from "../../lib/errors";
import { cronValidationError, nextCronRun } from "../../core/cron";
import { createJob } from "../../core/jobs";
import { getQueueChecked, requireProjectRole } from "../access";
import { ah, validate } from "../middleware";
import { createScheduleBody, patchScheduleBody } from "../schemas";
import type { Queue, ScheduledJob } from "../../types";

export const schedulesRouter = Router();

async function getScheduleChecked(
  req: { auth: { userId: string | null; apiKeyProjectId: string | null } },
  scheduleId: string,
  min: "member" | "admin",
): Promise<{ schedule: ScheduledJob; queue: Queue }> {
  const schedule = await qOne<ScheduledJob>(pool, "SELECT * FROM scheduled_jobs WHERE id = $1", [
    scheduleId,
  ]);
  if (!schedule) throw ApiError.notFound("schedule");
  const queue = await qOne<Queue>(pool, "SELECT * FROM queues WHERE id = $1", [schedule.queueId]);
  if (!queue) throw ApiError.notFound("schedule");
  await requireProjectRole(pool, req.auth, queue.projectId, min);
  return { schedule, queue };
}

schedulesRouter.get(
  "/queues/:queueId/schedules",
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "member");
    const data = await q(
      pool,
      "SELECT * FROM scheduled_jobs WHERE queue_id = $1 ORDER BY created_at",
      [queue.id],
    );
    res.json({ data });
  }),
);

schedulesRouter.post(
  "/queues/:queueId/schedules",
  validate(createScheduleBody),
  ah(async (req, res) => {
    const queue = await getQueueChecked(pool, req.auth, req.params.queueId, "admin");
    const b = req.body as {
      name: string;
      cronExpression: string;
      timezone: string;
      jobType: string;
      payload?: unknown;
      priority: number;
    };
    const cronError = cronValidationError(b.cronExpression, b.timezone);
    if (cronError) throw ApiError.validation(`invalid cron expression: ${cronError}`);
    const schedule = (
      await q(
        pool,
        `INSERT INTO scheduled_jobs (queue_id, name, cron_expression, timezone, job_type, payload, priority, next_run_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          queue.id,
          b.name,
          b.cronExpression,
          b.timezone,
          b.jobType,
          JSON.stringify(b.payload ?? {}),
          b.priority,
          nextCronRun(b.cronExpression, b.timezone),
        ],
      )
    )[0];
    res.status(201).json({ schedule });
  }),
);

schedulesRouter.patch(
  "/schedules/:scheduleId",
  validate(patchScheduleBody),
  ah(async (req, res) => {
    const { schedule } = await getScheduleChecked(req, req.params.scheduleId, "admin");
    const b = req.body as Partial<{
      name: string;
      cronExpression: string;
      timezone: string;
      jobType: string;
      payload: unknown;
      priority: number;
      isActive: boolean;
    }>;

    const cron = b.cronExpression ?? schedule.cronExpression;
    const tz = b.timezone ?? schedule.timezone;
    const cronError = cronValidationError(cron, tz);
    if (cronError) throw ApiError.validation(`invalid cron expression: ${cronError}`);

    // Recompute next_run_at when the timing changes or the schedule reactivates.
    const timingChanged =
      b.cronExpression !== undefined || b.timezone !== undefined || b.isActive === true;
    const updated = (
      await q(
        pool,
        `UPDATE scheduled_jobs SET
           name = $2, cron_expression = $3, timezone = $4, job_type = $5,
           payload = $6, priority = $7, is_active = $8,
           next_run_at = CASE WHEN $9 THEN $10::timestamptz ELSE next_run_at END
         WHERE id = $1 RETURNING *`,
        [
          schedule.id,
          b.name ?? schedule.name,
          cron,
          tz,
          b.jobType ?? schedule.jobType,
          JSON.stringify(b.payload !== undefined ? b.payload : schedule.payload ?? {}),
          b.priority ?? schedule.priority,
          b.isActive ?? schedule.isActive,
          timingChanged,
          timingChanged ? nextCronRun(cron, tz) : null,
        ],
      )
    )[0];
    res.json({ schedule: updated });
  }),
);

schedulesRouter.delete(
  "/schedules/:scheduleId",
  ah(async (req, res) => {
    const { schedule } = await getScheduleChecked(req, req.params.scheduleId, "admin");
    await pool.query("DELETE FROM scheduled_jobs WHERE id = $1", [schedule.id]);
    res.json({ deleted: true });
  }),
);

/** Fire the schedule immediately without touching its cron cadence. */
schedulesRouter.post(
  "/schedules/:scheduleId/trigger",
  ah(async (req, res) => {
    const { schedule, queue } = await getScheduleChecked(req, req.params.scheduleId, "member");
    const { job } = await withTx((tx) =>
      createJob(tx, queue, {
        type: schedule.jobType,
        payload: schedule.payload,
        priority: schedule.priority,
        scheduledJobId: schedule.id,
        createdBy: req.auth.userId ?? undefined,
      }),
    );
    res.status(201).json({ job });
  }),
);
