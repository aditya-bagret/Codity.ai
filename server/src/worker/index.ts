import { randomUUID } from "node:crypto";
import os from "node:os";
import { config } from "../config";
import { pool, withTx } from "../db/pool";
import { createLogger, type Logger } from "../logger";
import { claimJobs } from "../core/claim";
import { addJobLog, completeExecution, failExecution, startExecution } from "../core/jobs";
import { heartbeat, registerWorker, setWorkerStatus } from "../core/workers";
import { SchedulerLeader } from "../core/scheduler";
import { handlerRegistry, type JobContext, type JobTypeDefinition } from "../jobs/handlers";
import type { Job } from "../types";

export interface WorkerOptions {
  name?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  /** Queue names to subscribe to; null/empty = all queues. */
  queues?: string[] | null;
  handlers?: Map<string, JobTypeDefinition>;
  /** Participate in scheduler leader election (default true). */
  runScheduler?: boolean;
  drainTimeoutMs?: number;
}

/** Rejects when the signal aborts; raced against the handler for timeouts. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () => reject(new Error("timeout"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The worker service. Lifecycle per job:
 *
 *   claim (atomic, core/claim) → startExecution (claimed→running, execution
 *   row) → handler with AbortSignal timeout → completeExecution /
 *   failExecution (retry backoff or DLQ).
 *
 * Also sends heartbeats, participates in scheduler leader election, and
 * drains gracefully on stop(): no new claims, in-flight jobs get up to
 * drainTimeoutMs to finish, stragglers are recovered later via lease expiry.
 */
export class Worker {
  readonly id = randomUUID();
  readonly name: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatMs: number;
  private readonly queues: string[] | null;
  private readonly handlers: Map<string, JobTypeDefinition>;
  private readonly drainTimeoutMs: number;
  private readonly scheduler: SchedulerLeader | null;

  private readonly inflight = new Map<string, Promise<void>>();
  private running = false;
  private stopping = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private wakeFn: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private log: Logger;

  constructor(opts: WorkerOptions = {}) {
    this.name = opts.name || config.worker.name || `${os.hostname()}-${process.pid}`;
    this.concurrency = opts.concurrency ?? config.worker.concurrency;
    this.pollIntervalMs = opts.pollIntervalMs ?? config.worker.pollIntervalMs;
    this.heartbeatMs = opts.heartbeatMs ?? config.worker.heartbeatMs;
    const queues = opts.queues ?? config.worker.queues;
    this.queues = queues && queues.length > 0 ? queues : null;
    this.handlers = opts.handlers ?? handlerRegistry;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? config.worker.drainTimeoutMs;
    this.scheduler = (opts.runScheduler ?? true) ? new SchedulerLeader() : null;
    this.log = createLogger({ worker: this.name, workerId: this.id.slice(0, 8) });
  }

  get activeCount(): number {
    return this.inflight.size;
  }

  async start(): Promise<void> {
    await registerWorker(pool, {
      id: this.id,
      name: this.name,
      hostname: os.hostname(),
      pid: process.pid,
      maxConcurrency: this.concurrency,
      queueFilter: this.queues,
    });
    this.running = true;
    this.scheduler?.start();
    this.heartbeatTimer = setInterval(() => void this.beat(), this.heartbeatMs);
    this.loopDone = this.pollLoop();
    this.log.info("worker online", {
      concurrency: this.concurrency,
      queues: this.queues ?? "all",
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      const capacity = this.concurrency - this.inflight.size;
      if (capacity > 0) {
        try {
          const jobs = await claimJobs(this.id, capacity, this.queues);
          claimed = jobs.length;
          for (const job of jobs) this.launch(job);
        } catch (err) {
          this.log.error("claim cycle failed", { err: err as Error });
        }
      }
      // Re-poll immediately while there is both work and capacity; otherwise
      // sleep with jitter so a fleet of workers doesn't poll in lockstep.
      if (claimed === 0 || this.inflight.size >= this.concurrency) {
        await this.sleep(this.pollIntervalMs * (0.8 + Math.random() * 0.4));
      }
    }
  }

  private launch(job: Job): void {
    const promise = this.execute(job)
      .catch((err) => this.log.error("execution pipeline error", { jobId: job.id, err: err as Error }))
      .finally(() => this.inflight.delete(job.id));
    this.inflight.set(job.id, promise);
  }

  private async execute(job: Job): Promise<void> {
    const log = this.log.child({ jobId: job.id, type: job.type, attempt: job.attempts + 1 });
    const execution = await withTx((tx) => startExecution(tx, job, this.id));

    const def = this.handlers.get(job.type);
    if (!def) {
      await withTx((tx) =>
        failExecution(tx, job, execution, `no handler registered for job type "${job.type}"`, "failed"),
      );
      log.warn("no handler for job type");
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), job.timeoutMs);
    const ctx: JobContext = {
      job,
      payload: (job.payload ?? {}) as Record<string, unknown>,
      signal: controller.signal,
      log: (level, message) => addJobLog(pool, job.id, level, message, execution.id).catch(() => {}),
      progress: async (percent) => {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        await pool
          .query("UPDATE jobs SET progress = $2 WHERE id = $1 AND status = 'running'", [job.id, clamped])
          .catch(() => {});
      },
    };

    const startedAt = Date.now();
    try {
      const result = await Promise.race([def.handler(ctx), rejectOnAbort(controller.signal)]);
      clearTimeout(timeout);
      const { stolen } = await withTx((tx) => completeExecution(tx, job, execution, result));
      if (stolen) {
        log.warn("finished after lease expiry; reaper already reclaimed this job");
      } else {
        log.info("job completed", { durationMs: Date.now() - startedAt });
      }
    } catch (err) {
      clearTimeout(timeout);
      const timedOut = controller.signal.aborted;
      const message = timedOut
        ? `timed out after ${job.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      const outcome = await withTx((tx) =>
        failExecution(tx, job, execution, message, timedOut ? "timed_out" : "failed"),
      );
      log.warn("job attempt failed", {
        error: message,
        willRetry: outcome.retryAt !== null,
        deadLettered: outcome.dead,
      });
    }
  }

  private async beat(): Promise<void> {
    try {
      const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
      await heartbeat(pool, this.id, this.inflight.size, rssMb);
    } catch (err) {
      this.log.warn("heartbeat failed", { err: err as Error });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wakeFn = null;
        resolve();
      }, ms);
      this.wakeFn = () => {
        clearTimeout(t);
        this.wakeFn = null;
        resolve();
      };
    });
  }

  /** Graceful shutdown: stop claiming, drain in-flight work, go offline. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    this.wakeFn?.();
    await this.loopDone.catch(() => {});

    this.log.info("draining", { inflight: this.inflight.size });
    await setWorkerStatus(pool, this.id, "draining").catch(() => {});
    if (this.scheduler) await this.scheduler.stop();

    const drained = await Promise.race([
      Promise.allSettled([...this.inflight.values()]).then(() => true as const),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), this.drainTimeoutMs)),
    ]);
    if (!drained) {
      this.log.warn("drain timeout reached; remaining jobs will be recovered via lease expiry", {
        abandoned: this.inflight.size,
      });
    }

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await setWorkerStatus(pool, this.id, "offline").catch(() => {});
    this.log.info("worker stopped");
  }
}
