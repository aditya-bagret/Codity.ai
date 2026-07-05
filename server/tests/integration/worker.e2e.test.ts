import { describe, expect, it } from "vitest";
import { createJob } from "../../src/core/jobs";
import { pool, q, qOne, withTx } from "../../src/db/pool";
import { Worker } from "../../src/worker/index";
import type { JobTypeDefinition } from "../../src/jobs/handlers";
import type { Job } from "../../src/types";
import { eventually, jobRow, mkRetryPolicy, seedContext, useDb } from "../helpers";

useDb();

function testHandlers(): Map<string, JobTypeDefinition> {
  const defs: JobTypeDefinition[] = [
    {
      type: "ok",
      description: "succeeds",
      samplePayload: {},
      handler: async ({ payload }) => ({ echoed: payload }),
    },
    {
      type: "boom",
      description: "always fails",
      samplePayload: {},
      handler: async () => {
        throw new Error("kaboom");
      },
    },
    {
      type: "slow",
      description: "takes ~400ms",
      samplePayload: {},
      handler: async ({ log }) => {
        await new Promise((r) => setTimeout(r, 400));
        await log("info", "slow finished");
        return { slow: true };
      },
    },
    {
      type: "hang",
      description: "ignores everything for 30s",
      samplePayload: {},
      handler: async () => {
        await new Promise((r) => setTimeout(r, 30_000));
        return { never: true };
      },
    },
  ];
  return new Map(defs.map((d) => [d.type, d]));
}

function mkWorker(): Worker {
  return new Worker({
    name: "e2e-worker",
    concurrency: 4,
    pollIntervalMs: 80,
    heartbeatMs: 250,
    handlers: testHandlers(),
    runScheduler: true, // also exercises leader election + promotion
    drainTimeoutMs: 5000,
  });
}

describe("worker end-to-end", () => {
  it("executes jobs, retries failures with backoff, times out hangs, and dead-letters", async () => {
    const ctx = await seedContext();
    // 1 retry with a 100ms fixed backoff so the full retry loop runs fast.
    const policy = await mkRetryPolicy(ctx.projectId, {
      strategy: "fixed",
      maxRetries: 1,
      baseDelayMs: 100,
      maxDelayMs: 100,
    });

    const okJobs: Job[] = [];
    for (let i = 0; i < 3; i++) {
      const { job } = await withTx((tx) =>
        createJob(tx, ctx.queue, { type: "ok", payload: { i } }),
      );
      okJobs.push(job);
    }
    const { job: boomJob } = await withTx((tx) =>
      createJob(tx, ctx.queue, { type: "boom", retryPolicyId: policy.id }),
    );
    const { job: hangJob } = await withTx((tx) =>
      createJob(tx, ctx.queue, { type: "hang", timeoutMs: 1000, retries: 0 }),
    );

    const worker = mkWorker();
    await worker.start();
    try {
      // All ok jobs complete with results.
      await eventually(async () => {
        const rows = await q<Job>(
          pool,
          "SELECT * FROM jobs WHERE type = 'ok' AND status = 'completed'",
        );
        return rows.length === 3 ? rows : null;
      });

      // boom: attempt 1 fails → 100ms backoff → scheduler promotes → attempt 2 fails → DLQ.
      await eventually(async () => {
        const row = await jobRow<Job>(boomJob.id);
        return row.status === "failed" ? row : null;
      });
      const boomRow = await jobRow<Job>(boomJob.id);
      expect(boomRow.attempts).toBe(2);
      expect(boomRow.lastError).toContain("kaboom");
      const executions = await q(pool, "SELECT * FROM job_executions WHERE job_id = $1", [
        boomJob.id,
      ]);
      expect(executions).toHaveLength(2);
      const dlq = await qOne<{ reason: string }>(
        pool,
        "SELECT reason FROM dead_letter_jobs WHERE job_id = $1 AND status = 'pending'",
        [boomJob.id],
      );
      expect(dlq).not.toBeNull();

      // hang: client-side timeout fires at ~1s → timed_out → no retries → DLQ.
      await eventually(async () => {
        const row = await jobRow<Job>(hangJob.id);
        return row.status === "failed" ? row : null;
      });
      const hangExec = await qOne<{ status: string; error: string }>(
        pool,
        "SELECT status, error FROM job_executions WHERE job_id = $1",
        [hangJob.id],
      );
      expect(hangExec!.status).toBe("timed_out");
      expect(hangExec!.error).toContain("timed out after 1000ms");

      // Heartbeats flow and the worker row is online.
      await eventually(async () => {
        const beats = await qOne<{ n: number }>(
          pool,
          "SELECT count(*)::int AS n FROM worker_heartbeats WHERE worker_id = $1",
          [worker.id],
        );
        return (beats?.n ?? 0) >= 2 ? beats : null;
      });
      const workerRow = await qOne<{ status: string }>(
        pool,
        "SELECT status FROM workers WHERE id = $1",
        [worker.id],
      );
      expect(workerRow!.status).toBe("online");
    } finally {
      await worker.stop();
    }

    const stopped = await qOne<{ status: string; stoppedAt: Date | null }>(
      pool,
      "SELECT status, stopped_at FROM workers WHERE id = $1",
      [worker.id],
    );
    expect(stopped!.status).toBe("offline");
    expect(stopped!.stoppedAt).toBeInstanceOf(Date);
  });

  it("drains in-flight jobs on graceful shutdown", async () => {
    const ctx = await seedContext();
    const { job } = await withTx((tx) => createJob(tx, ctx.queue, { type: "slow" }));

    const worker = mkWorker();
    await worker.start();

    // Wait until the slow job is actually in flight, then stop mid-execution.
    await eventually(async () => {
      const row = await jobRow<Job>(job.id);
      return row.status === "running" ? row : null;
    });
    await worker.stop();

    // stop() must have waited for the in-flight job to finish.
    const row = await jobRow<Job>(job.id);
    expect(row.status).toBe("completed");
    expect(row.result).toEqual({ slow: true });
  });
});
