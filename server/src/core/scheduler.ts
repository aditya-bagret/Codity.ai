import pg from "pg";
import { config } from "../config";
import { pool, q, qOne, withTx, type Db } from "../db/pool";
import { logger } from "../logger";
import { nextCronRun } from "./cron";
import { addJobLog, failExecution, resolveRetry } from "./jobs";
import type { Job, JobExecution, Queue, ScheduledJob } from "../types";

/**
 * Scheduler ticks. These run on ONE process at a time (see SchedulerLeader
 * below), but every function is written to be safe even if two schedulers
 * raced: promotions are single atomic UPDATEs and cron materialization locks
 * schedule rows with FOR UPDATE SKIP LOCKED.
 */

/** scheduled → queued for jobs whose run_at has arrived (delays, retries). */
export async function promoteDueJobs(db: Db = pool): Promise<number> {
  const res = await db.query(
    "UPDATE jobs SET status = 'queued' WHERE status = 'scheduled' AND run_at <= now()",
  );
  return res.rowCount ?? 0;
}

/** Enqueues one job per due cron schedule and advances next_run_at. */
export async function materializeDueSchedules(): Promise<number> {
  return withTx(async (tx) => {
    const due = await q<ScheduledJob>(
      tx,
      `SELECT * FROM scheduled_jobs
       WHERE is_active AND next_run_at IS NOT NULL AND next_run_at <= now()
       ORDER BY next_run_at
       LIMIT 100
       FOR UPDATE SKIP LOCKED`,
    );
    for (const schedule of due) {
      const queue = await qOne<Queue>(tx, "SELECT * FROM queues WHERE id = $1", [schedule.queueId]);
      if (!queue) continue;
      const retry = await resolveRetry(tx, queue, {});
      const rows = await q<Job>(
        tx,
        `INSERT INTO jobs (queue_id, scheduled_job_id, type, payload, priority, status, run_at,
                           max_attempts, timeout_ms, retry_strategy, retry_base_delay_ms,
                           retry_max_delay_ms, retry_jitter)
         VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          queue.id,
          schedule.id,
          schedule.jobType,
          JSON.stringify(schedule.payload ?? {}),
          schedule.priority,
          schedule.nextRunAt,
          retry.maxAttempts,
          queue.defaultTimeoutMs,
          retry.strategy,
          retry.baseDelayMs,
          retry.maxDelayMs,
          retry.jitter,
        ],
      );
      await addJobLog(tx, rows[0].id, "info", `Enqueued by schedule "${schedule.name}" (${schedule.cronExpression})`);
      // Missed occurrences are skipped, not backfilled: next run is computed
      // from now, so an outage doesn't cause a thundering herd on recovery.
      const next = nextCronRun(schedule.cronExpression, schedule.timezone, new Date());
      await tx.query(
        "UPDATE scheduled_jobs SET next_run_at = $2, last_enqueued_at = now() WHERE id = $1",
        [schedule.id, next],
      );
    }
    return due.length;
  });
}

/**
 * Failure detection: declares workers dead after missed heartbeats, then
 * reclaims their jobs plus any job whose lease expired (hung worker). Lost
 * executions consume an attempt and follow the normal retry/DLQ path.
 */
export async function reapExpired(): Promise<{ deadWorkers: number; reclaimed: number }> {
  const dead = await q<{ id: string }>(
    pool,
    `UPDATE workers SET status = 'dead', stopped_at = COALESCE(stopped_at, now())
     WHERE status IN ('online', 'draining')
       AND last_heartbeat_at < now() - make_interval(secs => $1::double precision / 1000)
     RETURNING id`,
    [config.scheduler.deadWorkerAfterMs],
  );
  if (dead.length > 0) {
    logger.warn("declared workers dead (missed heartbeats)", { workerIds: dead.map((d) => d.id) });
  }

  let reclaimed = 0;
  // Loop until no expired jobs remain; each iteration handles a small batch.
  for (;;) {
    const batch = await withTx(async (tx) => {
      const expired = await q<Job>(
        tx,
        `SELECT j.* FROM jobs j
         WHERE j.status IN ('claimed', 'running')
           AND (
             j.lease_expires_at < now()
             OR j.claimed_by IN (SELECT id FROM workers WHERE status = 'dead')
           )
         LIMIT 20
         FOR UPDATE OF j SKIP LOCKED`,
      );
      for (const job of expired) {
        const exec = await qOne<JobExecution>(
          tx,
          `SELECT * FROM job_executions WHERE job_id = $1 AND status = 'running'
           ORDER BY started_at DESC LIMIT 1`,
          [job.id],
        );
        if (exec) {
          await failExecution(tx, job, exec, "worker lost or lease expired", "lost");
        } else {
          // Claimed but never started (worker died between claim and start):
          // no attempt was consumed, put it straight back.
          await tx.query(
            `UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
               lease_expires_at = NULL WHERE id = $1`,
            [job.id],
          );
          await addJobLog(tx, job.id, "warn", "Requeued: claiming worker disappeared before starting");
        }
      }
      return expired.length;
    });
    reclaimed += batch;
    if (batch < 20) break;
  }
  return { deadWorkers: dead.length, reclaimed };
}

/** Housekeeping: trims heartbeat history and long-dead worker rows. */
export async function pruneHistory(): Promise<void> {
  await pool.query("DELETE FROM worker_heartbeats WHERE created_at < now() - interval '24 hours'");
  await pool.query(
    `DELETE FROM workers WHERE status IN ('dead', 'offline')
     AND COALESCE(stopped_at, last_heartbeat_at) < now() - interval '24 hours'`,
  );
}

// ---------------------------------------------------------------------------
// Leader election
// ---------------------------------------------------------------------------

const LEADER_LOCK_KEY = "codity:scheduler-leader";

/**
 * Any number of worker processes may run a SchedulerLeader; a session-scoped
 * Postgres advisory lock guarantees only one actually executes ticks. If the
 * leader dies, its connection drops, the lock releases, and another worker
 * takes over within one tick interval.
 */
export class SchedulerLeader {
  private client: pg.Client | null = null;
  private isLeader = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private ticksSincePrune = 0;
  private log = logger.child({ component: "scheduler" });

  start(): void {
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    try {
      if (!this.client) {
        const client = new pg.Client({ connectionString: config.databaseUrl });
        client.on("error", () => {
          // Connection died: we are no longer leader; reconnect next tick.
          this.client = null;
          this.isLeader = false;
        });
        await client.connect();
        this.client = client;
      }
      if (!this.isLeader) {
        const res = await this.client.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
          [LEADER_LOCK_KEY],
        );
        if (res.rows[0].locked === true) {
          this.isLeader = true;
          this.log.info("acquired scheduler leadership");
        }
      }
      if (this.isLeader) {
        const promoted = await promoteDueJobs();
        const materialized = await materializeDueSchedules();
        const { deadWorkers, reclaimed } = await reapExpired();
        if (promoted || materialized || deadWorkers || reclaimed) {
          this.log.debug("tick", { promoted, materialized, deadWorkers, reclaimed });
        }
        if (++this.ticksSincePrune >= 60) {
          this.ticksSincePrune = 0;
          await pruneHistory();
        }
      }
    } catch (err) {
      this.log.error("scheduler tick failed", { err: err as Error });
      this.isLeader = false;
      if (this.client) {
        await this.client.end().catch(() => {});
        this.client = null;
      }
    }
    this.schedule(config.scheduler.tickMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.client) {
      await this.client.end().catch(() => {}); // releases the advisory lock
      this.client = null;
    }
    if (this.isLeader) this.log.info("released scheduler leadership");
    this.isLeader = false;
  }
}
