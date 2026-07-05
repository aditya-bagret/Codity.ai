export type JobStatus =
  | "scheduled"
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  organizationId: string;
  organizationName?: string;
  role?: string;
  queueCount?: number;
  apiKey?: string | null;
}

export interface RetryPolicy {
  id: string;
  projectId: string;
  name: string;
  strategy: "fixed" | "linear" | "exponential";
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export interface Queue {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  priority: number;
  maxConcurrency: number;
  rateLimitPerSec: number | null;
  defaultTimeoutMs: number;
  retryPolicyId: string | null;
  retryPolicyName?: string | null;
  isPaused: boolean;
  queued?: number;
  running?: number;
  scheduled?: number;
}

export interface Job {
  id: string;
  queueId: string;
  queueName?: string;
  type: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  progress: number | null;
  runAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  claimedAt?: string | null;
  claimedBy: string | null;
  lastError: string | null;
  batchId: string | null;
  scheduledJobId: string | null;
  idempotencyKey: string | null;
  payload?: unknown;
  result?: unknown;
  timeoutMs?: number;
  retryStrategy?: string;
}

export interface JobExecution {
  id: string;
  jobId: string;
  workerId: string | null;
  workerName?: string | null;
  attempt: number;
  status: "running" | "succeeded" | "failed" | "timed_out" | "lost";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  result: unknown;
}

export interface JobLog {
  id: string;
  jobId: string;
  executionId: string | null;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  createdAt: string;
}

export interface DlqEntry {
  id: string;
  jobId: string;
  queueId: string;
  queueName?: string;
  jobType: string;
  payload: unknown;
  reason: string;
  attemptsMade: number;
  status: "pending" | "retried" | "discarded";
  failedAt: string;
}

export interface Schedule {
  id: string;
  queueId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  jobType: string;
  payload: unknown;
  priority: number;
  isActive: boolean;
  nextRunAt: string | null;
  lastEnqueuedAt: string | null;
}

export interface WorkerInfo {
  id: string;
  name: string;
  hostname: string | null;
  pid: number | null;
  status: "online" | "draining" | "offline" | "dead";
  maxConcurrency: number;
  queueFilter: string[] | null;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt: string | null;
  activeJobs?: number;
  completed1h?: number;
  failed1h?: number;
}

export interface Heartbeat {
  id: string;
  workerId: string;
  activeJobs: number;
  rssMb: number | null;
  createdAt: string;
}

export interface ThroughputBucket {
  minute: string;
  succeeded: number;
  failed: number;
}

export interface QueueHealth {
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
  oldestQueuedAt: string | null;
}

export interface Overview {
  workersOnline: number;
  workersTotal: number;
  completed24h: number;
  failed24h: number;
  successRate24h: number | null;
  queuedBacklog: number;
  dlqPending: number;
  throughput: ThroughputBucket[];
  queues: QueueHealth[];
  recentFailures: Array<{
    executionId: string;
    jobId: string;
    jobType: string;
    queueName: string;
    status: string;
    error: string | null;
    finishedAt: string;
  }>;
}

export interface QueueStats {
  counts: Record<JobStatus, number>;
  dlqPending: number;
  oldestQueuedAgeMs: number | null;
  throughput: ThroughputBucket[];
  duration: { avgMs: number | null; p50Ms: number | null; p95Ms: number | null };
  successRate24h: number | null;
}

export interface JobTypeMeta {
  type: string;
  description: string;
  samplePayload: Record<string, unknown>;
}

export interface Meta {
  jobTypes: JobTypeMeta[];
}

export interface Page<T> {
  data: T[];
  pagination: { total: number; limit: number; offset: number };
}
