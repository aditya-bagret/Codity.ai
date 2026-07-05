export type JobStatus =
  | "scheduled"
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ExecutionStatus = "running" | "succeeded" | "failed" | "timed_out" | "lost";
export type WorkerStatus = "online" | "draining" | "offline" | "dead";
export type RetryStrategy = "fixed" | "linear" | "exponential";
export type OrgRole = "owner" | "admin" | "member";
export type DlqStatus = "pending" | "retried" | "discarded";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export interface Organization {
  id: string;
  name: string;
  createdAt: Date;
}

export interface OrganizationMember {
  organizationId: string;
  userId: string;
  role: OrgRole;
  createdAt: Date;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  apiKey: string;
  createdAt: Date;
}

export interface RetryPolicy {
  id: string;
  projectId: string;
  name: string;
  strategy: RetryStrategy;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  createdAt: Date;
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
  isPaused: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkerRow {
  id: string;
  name: string;
  hostname: string | null;
  pid: number | null;
  status: WorkerStatus;
  maxConcurrency: number;
  queueFilter: string[] | null;
  startedAt: Date;
  lastHeartbeatAt: Date;
  stoppedAt: Date | null;
}

export interface WorkerHeartbeat {
  id: string;
  workerId: string;
  activeJobs: number;
  rssMb: number | null;
  createdAt: Date;
}

export interface JobBatch {
  id: string;
  queueId: string;
  name: string | null;
  total: number;
  createdBy: string | null;
  createdAt: Date;
}

export interface ScheduledJob {
  id: string;
  queueId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  jobType: string;
  payload: unknown;
  priority: number;
  isActive: boolean;
  nextRunAt: Date | null;
  lastEnqueuedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Job {
  id: string;
  queueId: string;
  scheduledJobId: string | null;
  batchId: string | null;
  type: string;
  payload: unknown;
  priority: number;
  status: JobStatus;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  retryStrategy: RetryStrategy;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  retryJitter: boolean;
  idempotencyKey: string | null;
  progress: number | null;
  result: unknown;
  lastError: string | null;
  claimedBy: string | null;
  claimedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  leaseExpiresAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobExecution {
  id: string;
  jobId: string;
  workerId: string | null;
  attempt: number;
  status: ExecutionStatus;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  error: string | null;
  result: unknown;
}

export interface JobLog {
  id: string;
  jobId: string;
  executionId: string | null;
  level: LogLevel;
  message: string;
  createdAt: Date;
}

export interface DeadLetterJob {
  id: string;
  jobId: string;
  queueId: string;
  jobType: string;
  payload: unknown;
  reason: string;
  attemptsMade: number;
  status: DlqStatus;
  failedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}
