import { describe, expect, it } from "vitest";
import { claimJobs } from "../../src/core/claim";
import { createJob } from "../../src/core/jobs";
import { pool, withTx } from "../../src/db/pool";
import type { Job, Queue } from "../../src/types";
import { mkQueue, registerTestWorker, seedContext, useDb } from "../helpers";

useDb();

async function enqueue(queue: Queue, count: number, priority = 0): Promise<Job[]> {
  const jobs: Job[] = [];
  for (let i = 0; i < count; i++) {
    const { job } = await withTx((tx) =>
      createJob(tx, queue, { type: "test.noop", priority, payload: { i } }),
    );
    jobs.push(job);
  }
  return jobs;
}

describe("atomic claiming", () => {
  it("never hands the same job to two workers under heavy contention", async () => {
    const ctx = await seedContext({ maxConcurrency: 100 });
    await enqueue(ctx.queue, 5);
    const workers = await Promise.all(
      Array.from({ length: 4 }, (_, i) => registerTestWorker(`w${i}`)),
    );

    // 24 concurrent claim attempts racing for 5 jobs.
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => claimJobs(workers[i % 4].id, 2)),
    );

    const claimedIds = results.flat().map((j) => j.id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length); // no duplicates
    expect(claimedIds.length).toBe(5); // every job claimed exactly once
  });

  it("enforces the queue's global max_concurrency across workers", async () => {
    const ctx = await seedContext({ maxConcurrency: 2 });
    await enqueue(ctx.queue, 10);
    const w1 = await registerTestWorker("w1");
    const w2 = await registerTestWorker("w2");

    const results = await Promise.all([
      claimJobs(w1.id, 10),
      claimJobs(w2.id, 10),
      claimJobs(w1.id, 10),
    ]);
    expect(results.flat().length).toBe(2);

    // Still capped after the first two are running.
    expect((await claimJobs(w2.id, 10)).length).toBe(0);
  });

  it("skips paused queues", async () => {
    const ctx = await seedContext({ isPaused: true });
    await enqueue(ctx.queue, 3);
    const worker = await registerTestWorker();
    expect(await claimJobs(worker.id, 10)).toHaveLength(0);

    await pool.query("UPDATE queues SET is_paused = false WHERE id = $1", [ctx.queue.id]);
    expect(await claimJobs(worker.id, 10)).toHaveLength(3);
  });

  it("claims by job priority (desc), then FIFO", async () => {
    const ctx = await seedContext();
    const [low] = await enqueue(ctx.queue, 1, 0);
    const [high] = await enqueue(ctx.queue, 1, 10);
    const [mid1] = await enqueue(ctx.queue, 1, 5);
    const [mid2] = await enqueue(ctx.queue, 1, 5);
    const worker = await registerTestWorker();

    const claimed = await claimJobs(worker.id, 10);
    expect(claimed.map((j) => j.id)).toEqual([high.id, mid1.id, mid2.id, low.id]);
  });

  it("drains higher-priority queues first", async () => {
    const ctx = await seedContext({ priority: 0 });
    const urgent = await mkQueue(ctx.projectId, { priority: 10 });
    await enqueue(ctx.queue, 2);
    await enqueue(urgent, 2);
    const worker = await registerTestWorker();

    const claimed = await claimJobs(worker.id, 3);
    expect(claimed.slice(0, 2).every((j) => j.queueId === urgent.id)).toBe(true);
    expect(claimed[2].queueId).toBe(ctx.queue.id);
  });

  it("enforces per-second rate limits at claim time", async () => {
    const ctx = await seedContext({ rateLimitPerSec: 3 });
    await enqueue(ctx.queue, 10);
    const worker = await registerTestWorker();

    const claimed = await claimJobs(worker.id, 10);
    expect(claimed.length).toBeLessThanOrEqual(3);
    expect(claimed.length).toBeGreaterThan(0);
  });

  it("honors a worker's queue subscription filter", async () => {
    const ctx = await seedContext({ name: "emails" });
    const other = await mkQueue(ctx.projectId, { name: "reports" });
    await enqueue(ctx.queue, 2);
    await enqueue(other, 2);
    const worker = await registerTestWorker();

    const claimed = await claimJobs(worker.id, 10, ["reports"]);
    expect(claimed).toHaveLength(2);
    expect(claimed.every((j) => j.queueId === other.id)).toBe(true);
  });

  it("sets claim metadata and a lease on claimed jobs", async () => {
    const ctx = await seedContext();
    await enqueue(ctx.queue, 1);
    const worker = await registerTestWorker();

    const [job] = await claimJobs(worker.id, 1);
    expect(job.status).toBe("claimed");
    expect(job.claimedBy).toBe(worker.id);
    expect(job.claimedAt).toBeInstanceOf(Date);
    expect(job.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + job.timeoutMs);
  });
});
