-- ============================================================================
-- Codity initial schema
--
-- Conventions:
--   * uuid surrogate primary keys (gen_random_uuid, built into PG 13+).
--   * timestamptz everywhere; the application treats all times as UTC.
--   * Ownership chains cascade on delete (org -> project -> queue -> jobs),
--     while audit references (created_by, worker assignment) use SET NULL so
--     history survives the referenced row.
--   * Hot-path indexes are partial: the claim scan only ever looks at
--     status='queued' rows, so the index stays small no matter how much
--     completed history accumulates.
-- ============================================================================

CREATE TYPE job_status AS ENUM (
  'scheduled',  -- waiting for run_at (delay, cron materialization, or retry backoff)
  'queued',     -- ready to be claimed by a worker
  'claimed',    -- atomically claimed by a worker, about to start
  'running',    -- handler executing
  'completed',  -- terminal: success
  'failed',     -- terminal: retries exhausted, mirrored in dead_letter_jobs
  'cancelled'   -- terminal: cancelled while still pending
);

CREATE TYPE execution_status AS ENUM (
  'running', 'succeeded', 'failed', 'timed_out',
  'lost'        -- worker died or lease expired mid-execution
);

CREATE TYPE worker_status AS ENUM ('online', 'draining', 'offline', 'dead');
CREATE TYPE retry_strategy AS ENUM ('fixed', 'linear', 'exponential');
CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE dlq_status AS ENUM ('pending', 'retried', 'discarded');

-- ---------------------------------------------------------------------------
-- Identity & tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness without the citext extension.
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            org_role NOT NULL DEFAULT 'member',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

-- Reverse lookup: "which orgs am I in?"
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  -- Programmatic job submission credential (X-Api-Key header).
  api_key         text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- ---------------------------------------------------------------------------
-- Queue configuration
-- ---------------------------------------------------------------------------

CREATE TABLE retry_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text NOT NULL,
  strategy      retry_strategy NOT NULL DEFAULT 'exponential',
  max_retries   int NOT NULL DEFAULT 3 CHECK (max_retries BETWEEN 0 AND 20),
  base_delay_ms int NOT NULL DEFAULT 1000 CHECK (base_delay_ms BETWEEN 10 AND 3600000),
  max_delay_ms  int NOT NULL DEFAULT 60000 CHECK (max_delay_ms >= base_delay_ms),
  jitter        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE queues (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name               text NOT NULL,
  description        text,
  -- Queues with higher priority are drained first by workers.
  priority           int NOT NULL DEFAULT 0,
  -- Max jobs from this queue in claimed/running state across ALL workers.
  max_concurrency    int NOT NULL DEFAULT 5 CHECK (max_concurrency BETWEEN 1 AND 1000),
  -- Optional dispatch rate cap, enforced at claim time (NULL = unlimited).
  rate_limit_per_sec int CHECK (rate_limit_per_sec IS NULL OR rate_limit_per_sec BETWEEN 1 AND 10000),
  default_timeout_ms int NOT NULL DEFAULT 60000 CHECK (default_timeout_ms BETWEEN 1000 AND 1800000),
  -- SET NULL: deleting a policy falls back to platform defaults, jobs keep
  -- their own snapshot (see jobs.retry_*).
  retry_policy_id    uuid REFERENCES retry_policies(id) ON DELETE SET NULL,
  is_paused          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE INDEX queues_project_idx ON queues (project_id);

-- ---------------------------------------------------------------------------
-- Workers
-- ---------------------------------------------------------------------------

CREATE TABLE workers (
  id                uuid PRIMARY KEY,          -- generated by the worker process
  name              text NOT NULL,
  hostname          text,
  pid               int,
  status            worker_status NOT NULL DEFAULT 'online',
  max_concurrency   int NOT NULL,
  queue_filter      text[],                    -- NULL = subscribes to all queues
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  stopped_at        timestamptz
);

-- Liveness scan run by the reaper every tick.
CREATE INDEX workers_liveness_idx ON workers (status, last_heartbeat_at);

CREATE TABLE worker_heartbeats (
  id          bigserial PRIMARY KEY,
  worker_id   uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  active_jobs int NOT NULL DEFAULT 0,
  rss_mb      int,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX worker_heartbeats_worker_idx ON worker_heartbeats (worker_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

CREATE TABLE job_batches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id   uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  name       text,
  total      int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Recurring job definitions; the scheduler materializes them into jobs rows.
CREATE TABLE scheduled_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id         uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  name             text NOT NULL,
  cron_expression  text NOT NULL,
  timezone         text NOT NULL DEFAULT 'UTC',
  job_type         text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}',
  priority         int NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  next_run_at      timestamptz,
  last_enqueued_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (queue_id, name)
);

-- The scheduler polls "which schedules are due"; partial index keeps it tiny.
CREATE INDEX scheduled_jobs_due_idx ON scheduled_jobs (next_run_at) WHERE is_active;

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id         uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  scheduled_job_id uuid REFERENCES scheduled_jobs(id) ON DELETE SET NULL,
  batch_id         uuid REFERENCES job_batches(id) ON DELETE SET NULL,
  type             text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}',
  priority         int NOT NULL DEFAULT 0,   -- higher runs first within a queue
  status           job_status NOT NULL DEFAULT 'queued',
  run_at           timestamptz NOT NULL DEFAULT now(),

  -- Attempt accounting. attempts counts *concluded* executions (success,
  -- failure, timeout, or lost lease). max_attempts = retries + 1.
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 4 CHECK (max_attempts BETWEEN 1 AND 100),
  timeout_ms       int NOT NULL DEFAULT 60000 CHECK (timeout_ms BETWEEN 1000 AND 1800000),

  -- Retry policy SNAPSHOT taken at enqueue time: retries stay predictable
  -- even if the queue's policy is edited or deleted afterwards.
  retry_strategy      retry_strategy NOT NULL DEFAULT 'exponential',
  retry_base_delay_ms int NOT NULL DEFAULT 1000,
  retry_max_delay_ms  int NOT NULL DEFAULT 60000,
  retry_jitter        boolean NOT NULL DEFAULT true,

  idempotency_key  text,
  progress         smallint CHECK (progress BETWEEN 0 AND 100),
  result           jsonb,
  last_error       text,

  -- Worker assignment; kept after completion as an audit trail.
  claimed_by       uuid REFERENCES workers(id) ON DELETE SET NULL,
  claimed_at       timestamptz,
  started_at       timestamptz,
  completed_at     timestamptz,
  -- Fencing: a claimed/running job whose lease expires is reclaimed by the
  -- reaper even if its worker never reports back.
  lease_expires_at timestamptz,

  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- THE hot index: workers claim with
--   WHERE queue_id = $1 AND status = 'queued'
--   ORDER BY priority DESC, run_at, id
-- The partial predicate keeps it small and append-mostly.
CREATE INDEX jobs_claim_idx ON jobs (queue_id, priority DESC, run_at, id) WHERE status = 'queued';

-- Scheduler: promote due scheduled jobs to queued.
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE status = 'scheduled';

-- Reaper: find expired leases.
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE status IN ('claimed', 'running');

-- Dashboard listings and per-status counts.
CREATE INDEX jobs_queue_recent_idx ON jobs (queue_id, created_at DESC);
CREATE INDEX jobs_queue_status_idx ON jobs (queue_id, status);

-- Batch progress rollups.
CREATE INDEX jobs_batch_idx ON jobs (batch_id) WHERE batch_id IS NOT NULL;

-- Which jobs does a worker currently hold (reaper + worker detail page).
CREATE INDEX jobs_claimed_by_idx ON jobs (claimed_by) WHERE status IN ('claimed', 'running');

-- Exactly-once enqueue per client-chosen key, scoped to a queue.
CREATE UNIQUE INDEX jobs_idempotency_key ON jobs (queue_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Execution history & observability
-- ---------------------------------------------------------------------------

-- One row per attempt. This is the retry history: the jobs row holds only
-- current state, executions are immutable once finished.
CREATE TABLE job_executions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id   uuid REFERENCES workers(id) ON DELETE SET NULL,
  attempt     int NOT NULL,
  status      execution_status NOT NULL DEFAULT 'running',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms int,
  error       text,
  result      jsonb,
  UNIQUE (job_id, attempt)
);

CREATE INDEX job_executions_job_idx ON job_executions (job_id, started_at);
CREATE INDEX job_executions_worker_idx ON job_executions (worker_id, started_at DESC);
-- Throughput charts aggregate over finished_at.
CREATE INDEX job_executions_finished_idx ON job_executions (finished_at) WHERE finished_at IS NOT NULL;

CREATE TABLE job_logs (
  id           bigserial PRIMARY KEY,
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- NULL for lifecycle events (created, retry scheduled, moved to DLQ, ...).
  execution_id uuid REFERENCES job_executions(id) ON DELETE CASCADE,
  level        text NOT NULL DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_logs_job_idx ON job_logs (job_id, id);

-- ---------------------------------------------------------------------------
-- Dead letter queue
-- ---------------------------------------------------------------------------

-- Snapshot of permanently-failed jobs. Denormalizes type/payload so the entry
-- is self-contained for inspection and re-drive even as the jobs row moves on.
CREATE TABLE dead_letter_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  queue_id      uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  job_type      text NOT NULL,
  payload       jsonb NOT NULL,
  reason        text NOT NULL,
  attempts_made int NOT NULL,
  status        dlq_status NOT NULL DEFAULT 'pending',
  failed_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX dead_letter_jobs_queue_idx ON dead_letter_jobs (queue_id, status, failed_at DESC);
CREATE INDEX dead_letter_jobs_job_idx ON dead_letter_jobs (job_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER queues_updated_at BEFORE UPDATE ON queues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER scheduled_jobs_updated_at BEFORE UPDATE ON scheduled_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
