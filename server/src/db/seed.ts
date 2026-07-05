import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { closePool, pool, q, qOne, withTx } from "./pool";
import { migrate } from "./migrate";
import { nextCronRun } from "../core/cron";
import { createBatch, createJob } from "../core/jobs";
import type { Queue, RetryPolicy } from "../types";

export const DEMO_EMAIL = "demo@codity.dev";
export const DEMO_PASSWORD = "demo1234";

async function main(): Promise<void> {
  await migrate(pool);

  const existing = await qOne(pool, "SELECT id FROM users WHERE lower(email) = lower($1)", [DEMO_EMAIL]);
  if (existing) {
    console.log(`Already seeded — log in with ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    return;
  }

  const apiKey = "ck_" + randomBytes(24).toString("base64url");

  await withTx(async (tx) => {
    const user = (
      await q<{ id: string }>(
        tx,
        "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id",
        [DEMO_EMAIL, bcrypt.hashSync(DEMO_PASSWORD, 10), "Demo User"],
      )
    )[0];
    const org = (
      await q<{ id: string }>(tx, "INSERT INTO organizations (name) VALUES ($1) RETURNING id", [
        "Codity Demo Org",
      ])
    )[0];
    await tx.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
      [org.id, user.id],
    );
    const project = (
      await q<{ id: string }>(
        tx,
        "INSERT INTO projects (organization_id, name, api_key) VALUES ($1, $2, $3) RETURNING id",
        [org.id, "Acme App", apiKey],
      )
    )[0];

    const mkPolicy = async (
      name: string,
      strategy: string,
      maxRetries: number,
      baseDelayMs: number,
      maxDelayMs: number,
      jitter: boolean,
    ): Promise<RetryPolicy> =>
      (
        await q<RetryPolicy>(
          tx,
          `INSERT INTO retry_policies (project_id, name, strategy, max_retries, base_delay_ms, max_delay_ms, jitter)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [project.id, name, strategy, maxRetries, baseDelayMs, maxDelayMs, jitter],
        )
      )[0];

    const exponential = await mkPolicy("standard-exponential", "exponential", 3, 1000, 60_000, true);
    const linear = await mkPolicy("linear-patient", "linear", 5, 2000, 120_000, true);
    await mkPolicy("no-retry", "fixed", 0, 1000, 1000, false);

    const mkQueue = async (
      name: string,
      description: string,
      priority: number,
      maxConcurrency: number,
      policyId: string | null,
      opts: { rateLimitPerSec?: number; defaultTimeoutMs?: number } = {},
    ): Promise<Queue> =>
      (
        await q<Queue>(
          tx,
          `INSERT INTO queues (project_id, name, description, priority, max_concurrency,
                               retry_policy_id, rate_limit_per_sec, default_timeout_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            project.id,
            name,
            description,
            priority,
            maxConcurrency,
            policyId,
            opts.rateLimitPerSec ?? null,
            opts.defaultTimeoutMs ?? 60_000,
          ],
        )
      )[0];

    const emails = await mkQueue("emails", "Transactional email delivery", 10, 5, exponential.id, {
      defaultTimeoutMs: 30_000,
    });
    const webhooks = await mkQueue("webhooks", "Outbound webhook fan-out", 8, 10, exponential.id, {
      rateLimitPerSec: 5,
    });
    const reports = await mkQueue("reports", "Heavy report generation", 5, 2, linear.id, {
      defaultTimeoutMs: 120_000,
    });
    const media = await mkQueue("media", "Background media processing", 0, 3, exponential.id);

    const mkSchedule = async (
      queueId: string,
      name: string,
      cron: string,
      jobType: string,
      payload: unknown,
    ): Promise<void> => {
      await tx.query(
        `INSERT INTO scheduled_jobs (queue_id, name, cron_expression, timezone, job_type, payload, next_run_at)
         VALUES ($1, $2, $3, 'UTC', $4, $5, $6)`,
        [queueId, name, cron, jobType, JSON.stringify(payload), nextCronRun(cron, "UTC")],
      );
    };

    await mkSchedule(webhooks.id, "minutely-ping", "* * * * *", "demo.echo", { message: "cron ping" });
    await mkSchedule(emails.id, "hourly-digest", "0 * * * *", "email.send", {
      to: "digest@example.com",
      subject: "Hourly digest",
    });
    await mkSchedule(reports.id, "nightly-report", "30 2 * * *", "report.generate", { rows: 20_000 });

    // A few starter jobs so the dashboard isn't empty before the demo script runs.
    await createJob(tx, emails, {
      type: "email.send",
      payload: { to: "alice@example.com", subject: "Welcome to Codity" },
      createdBy: user.id,
    });
    await createJob(tx, emails, {
      type: "email.send",
      payload: { to: "bob@example.com", subject: "Your invoice" },
      runAt: new Date(Date.now() + 2 * 60_000),
      createdBy: user.id,
    });
    await createJob(tx, media, {
      type: "demo.fail",
      payload: { message: "corrupt input file (demo DLQ entry)" },
      retries: 2,
      createdBy: user.id,
    });
    await createBatch(
      tx,
      emails,
      "welcome-batch",
      [1, 2, 3, 4, 5].map((i) => ({
        type: "email.send",
        payload: { to: `user${i}@example.com`, subject: "Batch hello" },
      })),
      user.id,
    );
  });

  console.log("Seeded demo workspace:");
  console.log(`  dashboard login:  ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  project API key:  ${apiKey}`);
  console.log("  queues:           emails, webhooks, reports, media");
}

try {
  await main();
} finally {
  await closePool();
}
