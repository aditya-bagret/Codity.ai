import { pool, q, qOne, type Db } from "../db/pool";
import type { WorkerHeartbeat, WorkerRow, WorkerStatus } from "../types";

export interface RegisterWorkerInput {
  id: string;
  name: string;
  hostname: string;
  pid: number;
  maxConcurrency: number;
  queueFilter: string[] | null;
}

export async function registerWorker(db: Db, input: RegisterWorkerInput): Promise<WorkerRow> {
  const rows = await q<WorkerRow>(
    db,
    `INSERT INTO workers (id, name, hostname, pid, max_concurrency, queue_filter)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.id, input.name, input.hostname, input.pid, input.maxConcurrency, input.queueFilter],
  );
  return rows[0];
}

/** Refreshes liveness and appends a heartbeat history row. */
export async function heartbeat(
  db: Db,
  workerId: string,
  activeJobs: number,
  rssMb?: number,
): Promise<void> {
  await db.query("UPDATE workers SET last_heartbeat_at = now() WHERE id = $1", [workerId]);
  await db.query(
    "INSERT INTO worker_heartbeats (worker_id, active_jobs, rss_mb) VALUES ($1, $2, $3)",
    [workerId, activeJobs, rssMb ?? null],
  );
}

export async function setWorkerStatus(db: Db, workerId: string, status: WorkerStatus): Promise<void> {
  await db.query(
    `UPDATE workers SET status = $2,
       stopped_at = CASE WHEN $3 THEN now() ELSE stopped_at END
     WHERE id = $1`,
    [workerId, status, status === "offline" || status === "dead"],
  );
}

export interface WorkerSummary extends WorkerRow {
  activeJobs: number;
  completed1h: number;
  failed1h: number;
}

export async function listWorkers(db: Db = pool): Promise<WorkerSummary[]> {
  return q<WorkerSummary>(
    db,
    `SELECT w.*,
       (SELECT count(*)::int FROM jobs j
         WHERE j.claimed_by = w.id AND j.status IN ('claimed', 'running')) AS active_jobs,
       (SELECT count(*)::int FROM job_executions e
         WHERE e.worker_id = w.id AND e.status = 'succeeded'
           AND e.finished_at > now() - interval '1 hour') AS completed_1h,
       (SELECT count(*)::int FROM job_executions e
         WHERE e.worker_id = w.id AND e.status IN ('failed', 'timed_out', 'lost')
           AND e.finished_at > now() - interval '1 hour') AS failed_1h
     FROM workers w
     ORDER BY (w.status IN ('online', 'draining')) DESC, w.started_at DESC`,
  );
}

export interface WorkerDetail {
  worker: WorkerRow;
  heartbeats: WorkerHeartbeat[];
  currentJobs: Array<{ id: string; type: string; status: string; queueName: string; startedAt: Date | null }>;
}

export async function getWorkerDetail(db: Db, workerId: string): Promise<WorkerDetail | null> {
  const worker = await qOne<WorkerRow>(db, "SELECT * FROM workers WHERE id = $1", [workerId]);
  if (!worker) return null;
  const heartbeats = await q<WorkerHeartbeat>(
    db,
    `SELECT * FROM worker_heartbeats WHERE worker_id = $1
     ORDER BY created_at DESC LIMIT 120`,
    [workerId],
  );
  const currentJobs = await q<{ id: string; type: string; status: string; queueName: string; startedAt: Date | null }>(
    db,
    `SELECT j.id, j.type, j.status, q.name AS queue_name, j.started_at
     FROM jobs j JOIN queues q ON q.id = j.queue_id
     WHERE j.claimed_by = $1 AND j.status IN ('claimed', 'running')
     ORDER BY j.claimed_at`,
    [workerId],
  );
  return { worker, heartbeats: heartbeats.reverse(), currentJobs };
}
