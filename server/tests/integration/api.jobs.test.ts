import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app";
import { claimJobs } from "../../src/core/claim";
import { failExecution, startExecution } from "../../src/core/jobs";
import { qOne, pool, withTx } from "../../src/db/pool";
import type { Job } from "../../src/types";
import { registerTestWorker, useDb } from "../helpers";

useDb();
const app = createApp();

interface Session {
  token: string;
  orgId: string;
  projectId: string;
  queueId: string;
}

async function setup(name = `u${Date.now()}`): Promise<Session> {
  const reg = await request(app)
    .post("/api/auth/register")
    .send({ email: `${name}@test.dev`, password: "password123", name });
  const token = reg.body.token as string;
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

  const orgs = await auth(request(app).get("/api/orgs"));
  const orgId = orgs.body.data[0].id as string;
  const project = await auth(request(app).post("/api/projects")).send({
    organizationId: orgId,
    name: "Proj",
  });
  const queue = await auth(
    request(app).post(`/api/projects/${project.body.project.id}/queues`),
  ).send({ name: "work", maxConcurrency: 10 });
  expect(queue.status).toBe(201);
  return { token, orgId, projectId: project.body.project.id, queueId: queue.body.queue.id };
}

const bearer = (s: Session) => `Bearer ${s.token}`;

/** Drives a queued job to permanent failure through the core lifecycle. */
async function forceDeadLetter(jobId: string): Promise<void> {
  const worker = await registerTestWorker();
  const [job] = await claimJobs(worker.id, 10);
  expect(job.id).toBe(jobId);
  const exec = await withTx((tx) => startExecution(tx, job, worker.id));
  await withTx((tx) => failExecution(tx, job, exec, "forced failure", "failed"));
}

describe("job endpoints", () => {
  it("validates job creation", async () => {
    const s = await setup();
    const missingType = await request(app)
      .post(`/api/queues/${s.queueId}/jobs`)
      .set("Authorization", bearer(s))
      .send({ payload: {} });
    expect(missingType.status).toBe(400);
    expect(missingType.body.error.details).toHaveProperty("type");

    const both = await request(app)
      .post(`/api/queues/${s.queueId}/jobs`)
      .set("Authorization", bearer(s))
      .send({ type: "t", delayMs: 1000, runAt: new Date().toISOString() });
    expect(both.status).toBe(400);
  });

  it("creates, lists (with pagination + filters), and fetches jobs", async () => {
    const s = await setup();
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post(`/api/queues/${s.queueId}/jobs`)
        .set("Authorization", bearer(s))
        .send({ type: i < 3 ? "email.send" : "report.generate", payload: { i } });
      expect(res.status).toBe(201);
    }

    const page1 = await request(app)
      .get(`/api/queues/${s.queueId}/jobs?limit=5&offset=0`)
      .set("Authorization", bearer(s));
    expect(page1.body.data).toHaveLength(5);
    expect(page1.body.pagination).toEqual({ total: 12, limit: 5, offset: 0 });

    const filtered = await request(app)
      .get(`/api/queues/${s.queueId}/jobs?type=email.send&status=queued,scheduled`)
      .set("Authorization", bearer(s));
    expect(filtered.body.pagination.total).toBe(3);

    const jobId = page1.body.data[0].id as string;
    const detail = await request(app).get(`/api/jobs/${jobId}`).set("Authorization", bearer(s));
    expect(detail.status).toBe(200);
    expect(detail.body.job.queueName).toBe("work");
    expect(detail.body.executions).toEqual([]);
    expect(detail.body.dlq).toBeNull();

    const logs = await request(app).get(`/api/jobs/${jobId}/logs`).set("Authorization", bearer(s));
    expect(logs.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("returns the same job for duplicate idempotency keys", async () => {
    const s = await setup();
    const make = () =>
      request(app)
        .post(`/api/queues/${s.queueId}/jobs`)
        .set("Authorization", bearer(s))
        .send({ type: "t", idempotencyKey: "once" });
    const first = await make();
    const second = await make();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.deduped).toBe(true);
    expect(second.body.job.id).toBe(first.body.job.id);
  });

  it("cancels pending jobs and rejects double-cancel", async () => {
    const s = await setup();
    const created = await request(app)
      .post(`/api/queues/${s.queueId}/jobs`)
      .set("Authorization", bearer(s))
      .send({ type: "t", delayMs: 60_000 });
    const jobId = created.body.job.id as string;

    const cancel = await request(app)
      .post(`/api/jobs/${jobId}/cancel`)
      .set("Authorization", bearer(s));
    expect(cancel.status).toBe(200);
    expect(cancel.body.job.status).toBe("cancelled");

    const again = await request(app)
      .post(`/api/jobs/${jobId}/cancel`)
      .set("Authorization", bearer(s));
    expect(again.status).toBe(409);
  });

  it("creates batches and reports batch progress", async () => {
    const s = await setup();
    const batch = await request(app)
      .post(`/api/queues/${s.queueId}/jobs/batch`)
      .set("Authorization", bearer(s))
      .send({
        name: "blast",
        jobs: [
          { type: "t", payload: { i: 1 } },
          { type: "t", payload: { i: 2 }, delayMs: 30_000 },
          { type: "t", payload: { i: 3 } },
        ],
      });
    expect(batch.status).toBe(201);
    expect(batch.body.created).toBe(3);

    const progress = await request(app)
      .get(`/api/batches/${batch.body.batch.id}`)
      .set("Authorization", bearer(s));
    expect(progress.status).toBe(200);
    expect(progress.body.batch.counts.queued).toBe(2);
    expect(progress.body.batch.counts.scheduled).toBe(1);
  });

  it("supports the full DLQ flow: list, retry, discard", async () => {
    const s = await setup();
    const created = await request(app)
      .post(`/api/queues/${s.queueId}/jobs`)
      .set("Authorization", bearer(s))
      .send({ type: "t", retries: 0 });
    await forceDeadLetter(created.body.job.id);

    const list = await request(app)
      .get(`/api/queues/${s.queueId}/dlq`)
      .set("Authorization", bearer(s));
    expect(list.body.pagination.total).toBe(1);
    const entry = list.body.data[0];
    expect(entry.status).toBe("pending");
    expect(entry.reason).toContain("forced failure");

    const retry = await request(app)
      .post(`/api/dlq/${entry.id}/retry`)
      .set("Authorization", bearer(s));
    expect(retry.status).toBe(200);
    expect(retry.body.job.status).toBe("queued");

    const retryAgain = await request(app)
      .post(`/api/dlq/${entry.id}/retry`)
      .set("Authorization", bearer(s));
    expect(retryAgain.status).toBe(409); // already resolved

    // Second failure round → discard.
    await forceDeadLetter(created.body.job.id);
    const list2 = await request(app)
      .get(`/api/queues/${s.queueId}/dlq?status=pending`)
      .set("Authorization", bearer(s));
    const pendingEntry = list2.body.data[0];
    const discard = await request(app)
      .post(`/api/dlq/${pendingEntry.id}/discard`)
      .set("Authorization", bearer(s));
    expect(discard.status).toBe(200);
  });

  it("manages recurring schedules with cron validation", async () => {
    const s = await setup();
    const invalid = await request(app)
      .post(`/api/queues/${s.queueId}/schedules`)
      .set("Authorization", bearer(s))
      .send({ name: "bad", cronExpression: "not-cron", jobType: "t" });
    expect(invalid.status).toBe(400);

    const created = await request(app)
      .post(`/api/queues/${s.queueId}/schedules`)
      .set("Authorization", bearer(s))
      .send({ name: "nightly", cronExpression: "0 2 * * *", jobType: "report.generate", payload: { rows: 1 } });
    expect(created.status).toBe(201);
    expect(new Date(created.body.schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    const trigger = await request(app)
      .post(`/api/schedules/${created.body.schedule.id}/trigger`)
      .set("Authorization", bearer(s));
    expect(trigger.status).toBe(201);
    expect(trigger.body.job.type).toBe("report.generate");

    const paused = await request(app)
      .patch(`/api/schedules/${created.body.schedule.id}`)
      .set("Authorization", bearer(s))
      .send({ isActive: false });
    expect(paused.body.schedule.isActive).toBe(false);

    const deleted = await request(app)
      .delete(`/api/schedules/${created.body.schedule.id}`)
      .set("Authorization", bearer(s));
    expect(deleted.status).toBe(200);
  });

  it("manages queue config, pause/resume, and retry policies", async () => {
    const s = await setup();

    const policy = await request(app)
      .post(`/api/projects/${s.projectId}/retry-policies`)
      .set("Authorization", bearer(s))
      .send({ name: "gentle", strategy: "linear", maxRetries: 5, baseDelayMs: 2000, maxDelayMs: 30_000 });
    expect(policy.status).toBe(201);

    const badPolicy = await request(app)
      .post(`/api/projects/${s.projectId}/retry-policies`)
      .set("Authorization", bearer(s))
      .send({ name: "bad", baseDelayMs: 5000, maxDelayMs: 1000 });
    expect(badPolicy.status).toBe(400);

    const patched = await request(app)
      .patch(`/api/queues/${s.queueId}`)
      .set("Authorization", bearer(s))
      .send({ maxConcurrency: 42, retryPolicyId: policy.body.policy.id, priority: 7 });
    expect(patched.status).toBe(200);
    expect(patched.body.queue.maxConcurrency).toBe(42);

    const paused = await request(app)
      .post(`/api/queues/${s.queueId}/pause`)
      .set("Authorization", bearer(s));
    expect(paused.body.queue.isPaused).toBe(true);
    const resumed = await request(app)
      .post(`/api/queues/${s.queueId}/resume`)
      .set("Authorization", bearer(s));
    expect(resumed.body.queue.isPaused).toBe(false);

    // Policy from another project is rejected.
    const other = await setup("other");
    const cross = await request(app)
      .patch(`/api/queues/${other.queueId}`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({ retryPolicyId: policy.body.policy.id });
    expect(cross.status).toBe(400);
  });

  it("exposes queue stats and project overview", async () => {
    const s = await setup();
    await request(app)
      .post(`/api/queues/${s.queueId}/jobs`)
      .set("Authorization", bearer(s))
      .send({ type: "t" });

    const stats = await request(app)
      .get(`/api/queues/${s.queueId}/stats`)
      .set("Authorization", bearer(s));
    expect(stats.status).toBe(200);
    expect(stats.body.counts.queued).toBe(1);
    expect(stats.body.throughput).toHaveLength(60);

    const overview = await request(app)
      .get(`/api/projects/${s.projectId}/overview`)
      .set("Authorization", bearer(s));
    expect(overview.status).toBe(200);
    expect(overview.body.queuedBacklog).toBe(1);
    expect(overview.body.queues).toHaveLength(1);
  });
});
