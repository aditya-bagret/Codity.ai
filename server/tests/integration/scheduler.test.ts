import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { claimJobs } from "../../src/core/claim";
import { createJob, startExecution } from "../../src/core/jobs";
import {
  materializeDueSchedules,
  promoteDueJobs,
  reapExpired,
} from "../../src/core/scheduler";
import { pool, q, qOne, withTx } from "../../src/db/pool";
import type { Job, ScheduledJob } from "../../src/types";
import { jobRow, registerTestWorker, seedContext, useDb } from "../helpers";

useDb();

describe("scheduler ticks", () => {
  it("promotes only due scheduled jobs", async () => {
    const ctx = await seedContext();
    const { job: due } = await withTx((tx) =>
      createJob(tx, ctx.queue, { type: "t", runAt: new Date(Date.now() + 5000) }),
    );
    const { job: future } = await withTx((tx) =>
      createJob(tx, ctx.queue, { type: "t", runAt: new Date(Date.now() + 60_000) }),
    );
    await pool.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1", [
      due.id,
    ]);

    expect(await promoteDueJobs()).toBe(1);
    expect((await jobRow<Job>(due.id)).status).toBe("queued");
    expect((await jobRow<Job>(future.id)).status).toBe("scheduled");
  });

  it("materializes due cron schedules exactly once and advances next_run_at", async () => {
    const ctx = await seedContext();
    const schedule = (
      await q<ScheduledJob>(
        pool,
        `INSERT INTO scheduled_jobs (queue_id, name, cron_expression, timezone, job_type, payload, next_run_at)
         VALUES ($1, 'nightly', '*/5 * * * *', 'UTC', 'report.gen', '{"rows": 10}', now() - interval '1 second')
         RETURNING *`,
        [ctx.queue.id],
      )
    )[0];

    expect(await materializeDueSchedules()).toBe(1);
    // Second tick: nothing due anymore.
    expect(await materializeDueSchedules()).toBe(0);

    const jobs = await q<Job>(pool, "SELECT * FROM jobs WHERE scheduled_job_id = $1", [
      schedule.id,
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("report.gen");
    expect(jobs[0].payload).toEqual({ rows: 10 });
    expect(jobs[0].status).toBe("queued");

    const updated = await qOne<ScheduledJob>(pool, "SELECT * FROM scheduled_jobs WHERE id = $1", [
      schedule.id,
    ]);
    expect(updated!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(updated!.lastEnqueuedAt).toBeInstanceOf(Date);
  });

  it("skips inactive schedules", async () => {
    const ctx = await seedContext();
    await pool.query(
      `INSERT INTO scheduled_jobs (queue_id, name, cron_expression, job_type, is_active, next_run_at)
       VALUES ($1, 'off', '* * * * *', 't', false, now() - interval '1 minute')`,
      [ctx.queue.id],
    );
    expect(await materializeDueSchedules()).toBe(0);
  });
});

describe("failure detection (reaper)", () => {
  it("declares silent workers dead and retries their running jobs as lost", async () => {
    const ctx = await seedContext();
    await withTx((tx) => createJob(tx, ctx.queue, { type: "t", retries: 3 }));
    const worker = await registerTestWorker("doomed");
    const [job] = await claimJobs(worker.id, 1);
    await withTx((tx) => startExecution(tx, job, worker.id));

    // Worker stops heartbeating (beyond DEAD_WORKER_AFTER_MS).
    await pool.query("UPDATE workers SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [
      worker.id,
    ]);

    const { deadWorkers, reclaimed } = await reapExpired();
    expect(deadWorkers).toBe(1);
    expect(reclaimed).toBe(1);

    const row = await jobRow<Job>(job.id);
    expect(row.status).toBe("scheduled"); // lost attempt consumed, retry scheduled
    expect(row.attempts).toBe(1);
    expect(row.claimedBy).toBeNull();

    const exec = await qOne<{ status: string }>(
      pool,
      "SELECT status FROM job_executions WHERE job_id = $1",
      [job.id],
    );
    expect(exec!.status).toBe("lost");

    const workerRow = await qOne<{ status: string }>(pool, "SELECT status FROM workers WHERE id = $1", [
      worker.id,
    ]);
    expect(workerRow!.status).toBe("dead");
  });

  it("requeues claimed-but-never-started jobs without consuming an attempt", async () => {
    const ctx = await seedContext();
    await withTx((tx) => createJob(tx, ctx.queue, { type: "t" }));
    const worker = await registerTestWorker();
    const [job] = await claimJobs(worker.id, 1);
    // Worker dies between claim and start: no execution row exists.
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [
      job.id,
    ]);

    const { reclaimed } = await reapExpired();
    expect(reclaimed).toBe(1);
    const row = await jobRow<Job>(job.id);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
  });

  it("reclaims expired leases even when the worker still heartbeats (hung worker)", async () => {
    const ctx = await seedContext();
    await withTx((tx) => createJob(tx, ctx.queue, { type: "t", retries: 0 }));
    const worker = await registerTestWorker("hung");
    const [job] = await claimJobs(worker.id, 1);
    await withTx((tx) => startExecution(tx, job, worker.id));
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [
      job.id,
    ]);

    const { deadWorkers, reclaimed } = await reapExpired();
    expect(deadWorkers).toBe(0); // worker is alive, just hung on this job
    expect(reclaimed).toBe(1);

    // retries=0 → the lost attempt exhausted the budget → dead letter.
    const row = await jobRow<Job>(job.id);
    expect(row.status).toBe("failed");
    const dlq = await qOne(pool, "SELECT id FROM dead_letter_jobs WHERE job_id = $1", [job.id]);
    expect(dlq).not.toBeNull();
  });

  it("does not touch healthy running jobs", async () => {
    const ctx = await seedContext();
    await withTx((tx) => createJob(tx, ctx.queue, { type: "t" }));
    const worker = await registerTestWorker();
    const [job] = await claimJobs(worker.id, 1);
    await withTx((tx) => startExecution(tx, job, worker.id));

    const { reclaimed } = await reapExpired();
    expect(reclaimed).toBe(0);
    expect((await jobRow<Job>(job.id)).status).toBe("running");
  });
});
