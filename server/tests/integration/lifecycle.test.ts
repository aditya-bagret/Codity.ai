import { describe, expect, it } from "vitest";
import { claimJobs } from "../../src/core/claim";
import {
  cancelJob,
  completeExecution,
  createBatch,
  createJob,
  failExecution,
  retryJobNow,
  startExecution,
} from "../../src/core/jobs";
import { promoteDueJobs } from "../../src/core/scheduler";
import { batchProgress } from "../../src/core/stats";
import { pool, q, qOne, withTx } from "../../src/db/pool";
import type { Job, JobExecution } from "../../src/types";
import {
  jobRow,
  mkRetryPolicy,
  registerTestWorker,
  seedContext,
  useDb,
} from "../helpers";

useDb();

/** Claims one job and moves it to running, returning the execution. */
async function claimAndStart(workerId: string): Promise<{ job: Job; exec: JobExecution }> {
  const [job] = await claimJobs(workerId, 1);
  expect(job).toBeDefined();
  const exec = await withTx((tx) => startExecution(tx, job, workerId));
  return { job, exec };
}

describe("job lifecycle", () => {
  it("creates immediate jobs as queued and future jobs as scheduled", async () => {
    const ctx = await seedContext();
    const { job: now } = await withTx((tx) => createJob(tx, ctx.queue, { type: "t" }));
    const { job: later } = await withTx((tx) =>
      createJob(tx, ctx.queue, { type: "t", runAt: new Date(Date.now() + 60_000) }),
    );
    expect(now.status).toBe("queued");
    expect(later.status).toBe("scheduled");
  });

  it("dedupes on idempotency key within a queue", async () => {
    const ctx = await seedContext();
    const first = await withTx((tx) =>
      createJob(tx, ctx.queue, { type: "t", idempotencyKey: "order-42" }),
    );
    const second = await withTx((tx) =>
      createJob(tx, ctx.queue, { type: "t", idempotencyKey: "order-42" }),
    );
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it("runs the happy path: queued → claimed → running → completed", async () => {
    const ctx = await seedContext();
    await withTx((tx) => createJob(tx, ctx.queue, { type: "t", payload: { n: 7 } }));
    const worker = await registerTestWorker();

    const { job, exec } = await claimAndStart(worker.id);
    expect((await jobRow<Job>(job.id)).status).toBe("running");
    expect(exec.attempt).toBe(1);

    const { stolen } = await withTx((tx) => completeExecution(tx, job, exec, { ok: true }));
    expect(stolen).toBe(false);

    const done = await jobRow<Job>(job.id);
    expect(done.status).toBe("completed");
    expect(done.attempts).toBe(1);
    expect(done.progress).toBe(100);
    expect(done.completedAt).toBeInstanceOf(Date);
    expect(done.result).toEqual({ ok: true });

    const execRow = await qOne<JobExecution>(pool, "SELECT * FROM job_executions WHERE id = $1", [
      exec.id,
    ]);
    expect(execRow!.status).toBe("succeeded");
    expect(execRow!.durationMs).toBeGreaterThanOrEqual(0);

    const logs = await q(pool, "SELECT message FROM job_logs WHERE job_id = $1", [job.id]);
    expect(logs.length).toBeGreaterThanOrEqual(2); // created + succeeded
  });

  it("retries with backoff and dead-letters after exhausting attempts", async () => {
    const ctx = await seedContext();
    // Fixed 60s backoff, no jitter, 2 retries → 3 attempts total.
    const policy = await mkRetryPolicy(ctx.projectId, {
      strategy: "fixed",
      maxRetries: 2,
      baseDelayMs: 60_000,
      maxDelayMs: 60_000,
    });
    await withTx((tx) =>
      createJob(tx, ctx.queue, { type: "t", retryPolicyId: policy.id }),
    );
    const worker = await registerTestWorker();

    // Attempt 1 fails → scheduled for retry with the fixed backoff.
    const first = await claimAndStart(worker.id);
    const outcome1 = await withTx((tx) =>
      failExecution(tx, first.job, first.exec, "boom #1", "failed"),
    );
    expect(outcome1.dead).toBe(false);
    let row = await jobRow<Job>(first.job.id);
    expect(row.status).toBe("scheduled");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("boom #1");
    const delay = row.runAt.getTime() - Date.now();
    expect(delay).toBeGreaterThan(55_000);
    expect(delay).toBeLessThan(65_000);

    // Force the retry due, promote, fail attempts 2 and 3.
    for (const attempt of [2, 3]) {
      await pool.query("UPDATE jobs SET run_at = now() WHERE id = $1", [first.job.id]);
      expect(await promoteDueJobs()).toBe(1);
      const next = await claimAndStart(worker.id);
      expect(next.exec.attempt).toBe(attempt);
      await withTx((tx) => failExecution(tx, next.job, next.exec, `boom #${attempt}`, "failed"));
    }

    row = await jobRow<Job>(first.job.id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);

    const dlq = await qOne<{ status: string; attemptsMade: number; reason: string }>(
      pool,
      "SELECT status, attempts_made, reason FROM dead_letter_jobs WHERE job_id = $1",
      [first.job.id],
    );
    expect(dlq).not.toBeNull();
    expect(dlq!.status).toBe("pending");
    expect(dlq!.attemptsMade).toBe(3);
    expect(dlq!.reason).toContain("boom #3");

    const executions = await q(pool, "SELECT * FROM job_executions WHERE job_id = $1", [
      first.job.id,
    ]);
    expect(executions).toHaveLength(3);
  });

  it("timed-out executions consume an attempt with kind timed_out", async () => {
    const ctx = await seedContext();
    await withTx((tx) => createJob(tx, ctx.queue, { type: "t", retries: 0 }));
    const worker = await registerTestWorker();
    const { job, exec } = await claimAndStart(worker.id);

    const outcome = await withTx((tx) =>
      failExecution(tx, job, exec, "timed out after 1000ms", "timed_out"),
    );
    expect(outcome.dead).toBe(true);
    const execRow = await qOne<{ status: string }>(
      pool,
      "SELECT status FROM job_executions WHERE id = $1",
      [exec.id],
    );
    expect(execRow!.status).toBe("timed_out");
  });

  it("cancels pending jobs but not running ones", async () => {
    const ctx = await seedContext();
    const { job: pending } = await withTx((tx) => createJob(tx, ctx.queue, { type: "t" }));
    expect((await withTx((tx) => cancelJob(tx, pending.id)))?.status).toBe("cancelled");

    const { job: toRun } = await withTx((tx) => createJob(tx, ctx.queue, { type: "t" }));
    const worker = await registerTestWorker();
    await claimAndStart(worker.id);
    expect(await withTx((tx) => cancelJob(tx, toRun.id))).toBeNull();
  });

  it("manual retry re-queues a failed job and resolves its DLQ entry", async () => {
    const ctx = await seedContext();
    await withTx((tx) => createJob(tx, ctx.queue, { type: "t", retries: 0 }));
    const worker = await registerTestWorker();
    const { job, exec } = await claimAndStart(worker.id);
    await withTx((tx) => failExecution(tx, job, exec, "fatal", "failed"));

    const retried = await withTx((tx) => retryJobNow(tx, job.id, { extraAttempts: 2 }));
    expect(retried!.status).toBe("queued");
    expect(retried!.maxAttempts).toBe(retried!.attempts + 2);

    const dlq = await qOne<{ status: string }>(
      pool,
      "SELECT status FROM dead_letter_jobs WHERE job_id = $1",
      [job.id],
    );
    expect(dlq!.status).toBe("retried");

    // A queued job cannot be manually retried again.
    expect(await withTx((tx) => retryJobNow(tx, job.id, {}))).toBeNull();
  });

  it("late completions after reclaim are discarded (at-least-once)", async () => {
    const ctx = await seedContext();
    await withTx((tx) => createJob(tx, ctx.queue, { type: "t" }));
    const worker = await registerTestWorker();
    const { job, exec } = await claimAndStart(worker.id);

    // Simulate the reaper stealing the job (lease expired) before the worker finishes.
    await withTx((tx) => failExecution(tx, job, exec, "lease expired", "lost"));

    const { stolen } = await withTx((tx) => completeExecution(tx, job, exec, { late: true }));
    expect(stolen).toBe(true);
    const row = await jobRow<Job>(job.id);
    expect(row.status).toBe("scheduled"); // the retry from the lost attempt wins
    expect(row.result).toBeNull();
  });

  it("creates batches atomically and reports progress", async () => {
    const ctx = await seedContext();
    const { batch, jobs } = await withTx((tx) =>
      createBatch(tx, ctx.queue, "welcome", [
        { type: "t", payload: { i: 1 } },
        { type: "t", payload: { i: 2 }, delayMs: 60_000 },
        { type: "t", payload: { i: 3 } },
      ]),
    );
    expect(batch.total).toBe(3);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.batchId === batch.id)).toBe(true);

    const progress = await batchProgress(pool, batch.id);
    expect(progress!.counts.queued).toBe(2);
    expect(progress!.counts.scheduled).toBe(1);
  });
});
