import { closePool, pool, q, withTx } from "./pool";
import { createBatch, createJob } from "../core/jobs";
import type { Queue } from "../types";

/**
 * Enqueues a realistic burst of mixed work so the dashboard has something to
 * show: mostly-succeeding email/webhook traffic, slow reports, flaky jobs
 * that exercise retries, and a guaranteed DLQ candidate. Run any time:
 *   npm run demo
 */
async function main(): Promise<void> {
  const queues = await q<Queue>(pool, "SELECT * FROM queues ORDER BY created_at");
  const byName = new Map(queues.map((qu) => [qu.name, qu]));
  const emails = byName.get("emails");
  const webhooks = byName.get("webhooks");
  const reports = byName.get("reports");
  const media = byName.get("media");
  if (!emails || !webhooks || !reports || !media) {
    throw new Error("demo queues not found — run `npm run seed` first");
  }

  let count = 0;
  await withTx(async (tx) => {
    for (let i = 0; i < 25; i++) {
      await createJob(tx, emails, {
        type: "email.send",
        payload: { to: `customer${i}@example.com`, subject: `Order #${1000 + i} confirmed` },
        priority: i % 5 === 0 ? 5 : 0,
        runAt: new Date(Date.now() + i * 400),
      });
      count++;
    }
    // One with an invalid address: fails validation every attempt → DLQ.
    await createJob(tx, emails, {
      type: "email.send",
      payload: { to: "not-an-address", subject: "This one dead-letters" },
    });
    count++;

    for (let i = 0; i < 15; i++) {
      await createJob(tx, webhooks, {
        type: "webhook.dispatch",
        payload: { event: ["user.created", "order.paid", "cart.abandoned"][i % 3], url: "https://example.com/hooks" },
      });
      count++;
    }

    for (let i = 0; i < 6; i++) {
      await createJob(tx, reports, {
        type: "report.generate",
        payload: { rows: 2000 + i * 1500, format: i % 2 === 0 ? "csv" : "pdf" },
      });
      count++;
    }

    for (let i = 0; i < 8; i++) {
      await createJob(tx, media, {
        type: "demo.flaky",
        payload: { failureRate: 0.6, ms: 800 },
      });
      count++;
    }
    for (let i = 0; i < 4; i++) {
      await createJob(tx, media, {
        type: "demo.sleep",
        payload: { ms: 6000 },
      });
      count++;
    }

    const { jobs } = await createBatch(
      tx,
      emails,
      "campaign-blast",
      Array.from({ length: 20 }, (_, i) => ({
        type: "email.send",
        payload: { to: `subscriber${i}@example.com`, subject: "March newsletter" },
        delayMs: i * 250,
      })),
    );
    count += jobs.length;
  });

  console.log(`Enqueued ${count} demo jobs across ${queues.length} queues.`);
  console.log("Start one or more workers (`npm run worker`) and watch the dashboard.");
}

try {
  await main();
} finally {
  await closePool();
}
