import { pool, q, qOne, type Db } from "../db/pool";
import type { JobStatus } from "../types";

export interface StatusCounts {
  scheduled: number;
  queued: number;
  claimed: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface ThroughputBucket {
  minute: string; // ISO timestamp of the minute bucket
  succeeded: number;
  failed: number;
}

const EMPTY_COUNTS: StatusCounts = {
  scheduled: 0,
  queued: 0,
  claimed: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
};

/** Zero-fills minute buckets so charts render continuous bars. */
function fillBuckets(
  rows: Array<{ minute: Date; succeeded: number; failed: number }>,
  minutes: number,
): ThroughputBucket[] {
  const byMinute = new Map(rows.map((r) => [r.minute.getTime(), r]));
  const out: ThroughputBucket[] = [];
  const start = new Date();
  start.setSeconds(0, 0);
  for (let i = minutes - 1; i >= 0; i--) {
    const t = start.getTime() - i * 60_000;
    const hit = byMinute.get(t);
    out.push({
      minute: new Date(t).toISOString(),
      succeeded: hit?.succeeded ?? 0,
      failed: hit?.failed ?? 0,
    });
  }
  return out;
}

export interface QueueStats {
  counts: StatusCounts;
  dlqPending: number;
  oldestQueuedAgeMs: number | null;
  throughput: ThroughputBucket[];
  duration: { avgMs: number | null; p50Ms: number | null; p95Ms: number | null };
  successRate24h: number | null;
}

export async function queueStats(db: Db = pool, queueId: string, minutes = 60): Promise<QueueStats> {
  const countRows = await q<{ status: JobStatus; n: number }>(
    db,
    "SELECT status, count(*)::int AS n FROM jobs WHERE queue_id = $1 GROUP BY status",
    [queueId],
  );
  const counts = { ...EMPTY_COUNTS };
  for (const r of countRows) counts[r.status] = r.n;

  const dlq = await qOne<{ n: number }>(
    db,
    "SELECT count(*)::int AS n FROM dead_letter_jobs WHERE queue_id = $1 AND status = 'pending'",
    [queueId],
  );

  const oldest = await qOne<{ ageMs: number | null }>(
    db,
    `SELECT (EXTRACT(EPOCH FROM (now() - min(run_at))) * 1000)::bigint::int AS age_ms
     FROM jobs WHERE queue_id = $1 AND status = 'queued'`,
    [queueId],
  );

  const throughputRows = await q<{ minute: Date; succeeded: number; failed: number }>(
    db,
    `SELECT date_trunc('minute', e.finished_at) AS minute,
       count(*) FILTER (WHERE e.status = 'succeeded')::int AS succeeded,
       count(*) FILTER (WHERE e.status IN ('failed', 'timed_out', 'lost'))::int AS failed
     FROM job_executions e
     JOIN jobs j ON j.id = e.job_id
     WHERE j.queue_id = $1 AND e.finished_at > now() - make_interval(mins => $2)
     GROUP BY 1 ORDER BY 1`,
    [queueId, minutes],
  );

  const duration = await qOne<{ avgMs: number | null; p50Ms: number | null; p95Ms: number | null }>(
    db,
    `SELECT round(avg(duration_ms))::int AS avg_ms,
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::int AS p50_ms,
       (percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95_ms
     FROM job_executions e JOIN jobs j ON j.id = e.job_id
     WHERE j.queue_id = $1 AND e.status = 'succeeded' AND e.finished_at > now() - interval '24 hours'`,
    [queueId],
  );

  const success = await qOne<{ ok: number; total: number }>(
    db,
    `SELECT count(*) FILTER (WHERE e.status = 'succeeded')::int AS ok, count(*)::int AS total
     FROM job_executions e JOIN jobs j ON j.id = e.job_id
     WHERE j.queue_id = $1 AND e.finished_at > now() - interval '24 hours'`,
    [queueId],
  );

  return {
    counts,
    dlqPending: dlq?.n ?? 0,
    oldestQueuedAgeMs: oldest?.ageMs ?? null,
    throughput: fillBuckets(throughputRows, minutes),
    duration: {
      avgMs: duration?.avgMs ?? null,
      p50Ms: duration?.p50Ms ?? null,
      p95Ms: duration?.p95Ms ?? null,
    },
    successRate24h:
      success && success.total > 0 ? Math.round((success.ok / success.total) * 1000) / 10 : null,
  };
}

export interface QueueHealthRow {
  id: string;
  name: string;
  priority: number;
  isPaused: boolean;
  maxConcurrency: number;
  scheduled: number;
  queued: number;
  running: number;
  completed24h: number;
  failed24h: number;
  dlqPending: number;
  oldestQueuedAt: Date | null;
}

export interface ProjectOverview {
  workersOnline: number;
  workersTotal: number;
  completed24h: number;
  failed24h: number;
  successRate24h: number | null;
  queuedBacklog: number;
  dlqPending: number;
  throughput: ThroughputBucket[];
  queues: QueueHealthRow[];
  recentFailures: Array<{
    executionId: string;
    jobId: string;
    jobType: string;
    queueName: string;
    status: string;
    error: string | null;
    finishedAt: Date;
  }>;
}

export async function projectOverview(db: Db = pool, projectId: string): Promise<ProjectOverview> {
  const queues = await q<QueueHealthRow>(
    db,
    `SELECT q.id, q.name, q.priority, q.is_paused, q.max_concurrency,
       count(j.id) FILTER (WHERE j.status = 'scheduled')::int AS scheduled,
       count(j.id) FILTER (WHERE j.status = 'queued')::int AS queued,
       count(j.id) FILTER (WHERE j.status IN ('claimed', 'running'))::int AS running,
       count(j.id) FILTER (WHERE j.status = 'completed' AND j.completed_at > now() - interval '24 hours')::int AS completed_24h,
       count(j.id) FILTER (WHERE j.status = 'failed' AND j.completed_at > now() - interval '24 hours')::int AS failed_24h,
       (SELECT count(*)::int FROM dead_letter_jobs d WHERE d.queue_id = q.id AND d.status = 'pending') AS dlq_pending,
       min(j.run_at) FILTER (WHERE j.status = 'queued') AS oldest_queued_at
     FROM queues q
     LEFT JOIN jobs j ON j.queue_id = q.id
     WHERE q.project_id = $1
     GROUP BY q.id
     ORDER BY q.priority DESC, q.name`,
    [projectId],
  );

  const workers = await qOne<{ online: number; total: number }>(
    db,
    `SELECT count(*) FILTER (WHERE status IN ('online', 'draining'))::int AS online,
            count(*)::int AS total
     FROM workers`,
  );

  const throughputRows = await q<{ minute: Date; succeeded: number; failed: number }>(
    db,
    `SELECT date_trunc('minute', e.finished_at) AS minute,
       count(*) FILTER (WHERE e.status = 'succeeded')::int AS succeeded,
       count(*) FILTER (WHERE e.status IN ('failed', 'timed_out', 'lost'))::int AS failed
     FROM job_executions e
     JOIN jobs j ON j.id = e.job_id
     JOIN queues q ON q.id = j.queue_id
     WHERE q.project_id = $1 AND e.finished_at > now() - interval '60 minutes'
     GROUP BY 1 ORDER BY 1`,
    [projectId],
  );

  const totals = await qOne<{ ok: number; err: number }>(
    db,
    `SELECT count(*) FILTER (WHERE e.status = 'succeeded')::int AS ok,
            count(*) FILTER (WHERE e.status IN ('failed', 'timed_out', 'lost'))::int AS err
     FROM job_executions e
     JOIN jobs j ON j.id = e.job_id
     JOIN queues q ON q.id = j.queue_id
     WHERE q.project_id = $1 AND e.finished_at > now() - interval '24 hours'`,
    [projectId],
  );

  const recentFailures = await q<ProjectOverview["recentFailures"][number]>(
    db,
    `SELECT e.id AS execution_id, j.id AS job_id, j.type AS job_type, q.name AS queue_name,
            e.status, e.error, e.finished_at
     FROM job_executions e
     JOIN jobs j ON j.id = e.job_id
     JOIN queues q ON q.id = j.queue_id
     WHERE q.project_id = $1 AND e.status IN ('failed', 'timed_out', 'lost')
     ORDER BY e.finished_at DESC NULLS LAST
     LIMIT 10`,
    [projectId],
  );

  const ok = totals?.ok ?? 0;
  const err = totals?.err ?? 0;
  return {
    workersOnline: workers?.online ?? 0,
    workersTotal: workers?.total ?? 0,
    completed24h: ok,
    failed24h: err,
    successRate24h: ok + err > 0 ? Math.round((ok / (ok + err)) * 1000) / 10 : null,
    queuedBacklog: queues.reduce((sum, r) => sum + r.queued, 0),
    dlqPending: queues.reduce((sum, r) => sum + r.dlqPending, 0),
    throughput: fillBuckets(throughputRows, 60),
    queues,
    recentFailures,
  };
}

export interface BatchProgress {
  id: string;
  queueId: string;
  name: string | null;
  total: number;
  createdAt: Date;
  counts: StatusCounts;
}

export async function batchProgress(db: Db = pool, batchId: string): Promise<BatchProgress | null> {
  const batch = await qOne<{ id: string; queueId: string; name: string | null; total: number; createdAt: Date }>(
    db,
    "SELECT id, queue_id, name, total, created_at FROM job_batches WHERE id = $1",
    [batchId],
  );
  if (!batch) return null;
  const rows = await q<{ status: JobStatus; n: number }>(
    db,
    "SELECT status, count(*)::int AS n FROM jobs WHERE batch_id = $1 GROUP BY status",
    [batchId],
  );
  const counts = { ...EMPTY_COUNTS };
  for (const r of rows) counts[r.status] = r.n;
  return { ...batch, counts };
}
