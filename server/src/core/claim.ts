import { config } from "../config";
import { pool, q, qOne, withTx, type Db } from "../db/pool";
import type { Job, Queue } from "../types";

/**
 * Atomic job claiming.
 *
 * Two locking layers make this safe under many concurrent workers:
 *
 * 1. A per-queue transaction-scoped advisory lock serializes claimers of the
 *    SAME queue, making the concurrency-limit and rate-limit checks race-free
 *    (a plain SKIP LOCKED scan could overshoot the queue's max_concurrency
 *    when two workers count "active" simultaneously). The lock is blocking:
 *    the critical section is a couple of index lookups plus one UPDATE (~ms),
 *    so waiting is far cheaper than skipping and losing a whole poll cycle.
 *    Only one queue is ever locked per transaction, so deadlock is impossible.
 *
 * 2. FOR UPDATE SKIP LOCKED on the candidate job rows guards against anything
 *    else holding a row lock (e.g. a concurrent cancel) without ever waiting.
 *
 * Different queues claim fully in parallel.
 */

function queueLockKey(queueId: string): string {
  return `codity:queue:${queueId}`;
}

/**
 * Claims up to `capacity` due jobs for a worker, draining higher-priority
 * queues first. `queueNames` filters the queues this worker subscribes to
 * (null = all queues).
 */
export async function claimJobs(
  workerId: string,
  capacity: number,
  queueNames: string[] | null = null,
): Promise<Job[]> {
  if (capacity <= 0) return [];

  // Cheap, lock-free pre-scan: queues that plausibly have claimable work.
  const candidates = await q<{ id: string }>(
    pool,
    `SELECT q.id
     FROM queues q
     WHERE q.is_paused = false
       AND ($1::text[] IS NULL OR q.name = ANY($1))
       AND EXISTS (SELECT 1 FROM jobs j WHERE j.queue_id = q.id AND j.status = 'queued')
     ORDER BY q.priority DESC, q.created_at`,
    [queueNames && queueNames.length > 0 ? queueNames : null],
  );

  const claimed: Job[] = [];
  for (const { id } of candidates) {
    if (claimed.length >= capacity) break;
    const got = await claimFromQueue(id, workerId, capacity - claimed.length);
    claimed.push(...got);
  }
  return claimed;
}

/** Claims up to `want` jobs from one queue inside its advisory-locked section. */
export async function claimFromQueue(queueId: string, workerId: string, want: number): Promise<Job[]> {
  return withTx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      queueLockKey(queueId),
    ]);

    const queue = await qOne<Queue>(tx, "SELECT * FROM queues WHERE id = $1", [queueId]);
    if (!queue || queue.isPaused) return [];

    let slots = Math.min(want, await remainingConcurrency(tx, queue));
    if (queue.rateLimitPerSec !== null) {
      slots = Math.min(slots, await remainingRateBudget(tx, queue));
    }
    if (slots <= 0) return [];

    const claimed = await q<Job>(
      tx,
      `UPDATE jobs j SET
         status = 'claimed',
         claimed_by = $2,
         claimed_at = now(),
         lease_expires_at = now() + make_interval(secs => (j.timeout_ms + $3)::double precision / 1000)
       WHERE j.id IN (
         SELECT id FROM jobs
         WHERE queue_id = $1 AND status = 'queued'
         ORDER BY priority DESC, run_at, id
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       )
       RETURNING j.*`,
      [queueId, workerId, config.worker.leaseGraceMs, slots],
    );
    // UPDATE ... RETURNING does not preserve the subquery's ORDER BY; restore
    // the dispatch order so callers start the most urgent job first.
    return claimed.sort(
      (a, b) =>
        b.priority - a.priority ||
        a.runAt.getTime() - b.runAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  });
}

/** Free slots under the queue's global max_concurrency. */
async function remainingConcurrency(db: Db, queue: Queue): Promise<number> {
  const row = await qOne<{ active: number }>(
    db,
    `SELECT count(*)::int AS active FROM jobs
     WHERE queue_id = $1 AND status IN ('claimed', 'running')`,
    [queue.id],
  );
  return queue.maxConcurrency - (row?.active ?? 0);
}

/** Claims still allowed within the current one-second rate window. */
async function remainingRateBudget(db: Db, queue: Queue): Promise<number> {
  const row = await qOne<{ recent: number }>(
    db,
    `SELECT count(*)::int AS recent FROM jobs
     WHERE queue_id = $1 AND claimed_at >= date_trunc('second', now())`,
    [queue.id],
  );
  return (queue.rateLimitPerSec ?? Infinity) - (row?.recent ?? 0);
}
