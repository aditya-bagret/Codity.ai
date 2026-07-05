# Design Decisions

The trade-offs that shaped the system, in roughly the order they mattered.

## 1. Postgres as the queue

**Decision:** use PostgreSQL as both the system of record *and* the queue transport — no Redis/RabbitMQ/Kafka.

**Why:** the assignment's hard problems (atomic claiming, retries, exactly-once enqueue, visibility) are *transactional* problems. With the queue in Postgres, "claim a job, record the execution, update queue stats" is one ACID transaction; with a broker it's a distributed-consistency problem (the classic dual-write: DB row says running, broker message lost, or vice versa). Postgres primitives map 1:1 to queue needs: `FOR UPDATE SKIP LOCKED` (non-blocking claim), partial indexes (cheap ready-scan), advisory locks (queue mutexes, leader election). One less system to deploy also means the evaluator can run everything with `docker compose up -d`.

**Cost:** ceiling of roughly thousands of jobs/sec vs. a broker's hundreds of thousands. Acceptable here; the escape hatch is that `jobs` remains the source of record and a broker could later become just the dispatch transport.

## 2. Claiming: `SKIP LOCKED` + a per-queue advisory mutex

**Decision:** claim with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` wrapped in `pg_advisory_xact_lock(queue_id)`.

**Why:** `SKIP LOCKED` alone guarantees no two workers get the same *row*, but queue-level invariants (max concurrency, per-second rate) need a consistent read of "how many are running *right now*" — two concurrent claimers can both see `4 < 5` and overshoot. The advisory lock makes check-and-claim atomic per queue while different queues stay fully parallel.

**Blocking vs. try-lock:** the first implementation used `pg_try_advisory_xact_lock` (skip a contended queue, get it next poll). Testing 24 concurrent claimers showed bursts leaving capacity unclaimed for a full poll interval. Since the critical section is single-digit milliseconds and each transaction locks exactly one queue (so no deadlock), a *blocking* lock is strictly better: waiting ~2 ms beats waiting 750 ms. This is the kind of decision the contention test exists to force.

## 3. Retry configuration is *snapshotted* onto each job

**Decision:** at enqueue, resolve the policy (job override → queue policy → platform default) and copy `strategy/base/max/jitter/max_attempts` into columns on `jobs`.

**Why:** retries must be predictable. If backoff resolved through a join at failure time, editing or deleting a policy would silently change the behavior of thousands of in-flight jobs, and the failure path would depend on config-table availability. Denormalizing ~20 bytes per job buys immutable per-job contracts and a join-free hot path. The policy tables remain the authoring surface; the snapshot is the runtime truth.

## 4. Attempt accounting: `lost` counts, and history is append-only

**Decision:** `jobs.attempts` counts *concluded* executions (`succeeded/failed/timed_out/lost`); every attempt is an immutable `job_executions` row (`UNIQUE(job_id, attempt)`); a reclaimed (`lost`) execution consumes an attempt.

**Why:** the alternative — not charging an attempt when a worker dies — invites an unbounded loop: a poison job that crashes its worker would be redelivered forever. Charging lost attempts bounds total work per job at `max_attempts`, the same reasoning as SQS's receive count. Manual retry grants explicit extra attempts (`max_attempts = attempts + n`) instead of resetting counters, so the execution numbering (and audit trail) never rewrites history.

## 5. Failure detection: heartbeats *and* leases, not either alone

**Decision:** workers heartbeat every 5 s (dead after 20 s silent); independently, every claimed job carries `lease_expires_at = now() + timeout + grace`.

**Why:** the two catch different failures. A killed process stops heartbeating → all its jobs recovered at once, fast. But a *live* process can wedge on one job (event-loop block, stuck I/O) while heartbeats keep flowing — only a per-job lease catches that. The lease also acts as a fence: `completeExecution`/`failExecution` are status-guarded, so a zombie worker finishing after reclaim gets its late result discarded and logged rather than corrupting the retry that superseded it. Consequence: **at-least-once** execution, stated openly in the docs; handlers should be idempotent.

## 6. Scheduler inside the worker, elected by advisory lock

**Decision:** no separate scheduler deployable. Every worker runs a `SchedulerLeader` that competes for a session-scoped advisory lock; the holder ticks (promote due jobs, materialize cron, reap).

**Why:** a scheduler process would be a special snowflake — one more thing to run, monitor, and fail over. Advisory-lock election gives automatic failover for free: leader dies → connection drops → lock releases → another worker takes over within a tick. Every tick function is also written to be safe under accidental double-execution (atomic UPDATEs, `FOR UPDATE SKIP LOCKED` on schedule rows), so leadership is an optimization, not a correctness requirement. Cron catch-up policy: missed occurrences are skipped (next computed from `now()`), because backfilling an outage would thundering-herd recovery — the wrong default for background jobs.

## 7. Delayed jobs get an explicit `scheduled` state

**Decision:** future-dated and backoff-waiting jobs sit in `status='scheduled'` and are *promoted* to `queued` by the scheduler, rather than filtering `run_at <= now()` in the claim query.

**Why:** it keeps the claim index/predicate minimal (`status='queued'` only, no time filter), makes the assignment's lifecycle states directly observable (the dashboard genuinely shows *Scheduled*), and reuses one mechanism for both delays and retry backoff. Cost: up to one tick (1 s) of promotion latency — irrelevant for background work.

## 8. Workers talk to Postgres directly, not through the API

**Decision:** workers import the core modules and open their own DB pool; the REST API is for humans and integrations.

**Why:** claiming must be transactional with execution bookkeeping — tunneling `BEGIN … FOR UPDATE … COMMIT` through HTTP would either break atomicity or turn the API into a lock service. The cost (workers must reach the DB, and share a schema version with the API) is the standard shape for this architecture (Sidekiq, Oban, pg-boss all work this way). Code sharing keeps the contract in one module (`core/`), tested once.

## 9. Live updates by polling, not WebSockets

**Decision:** the dashboard polls (2.5–8 s per view, paused when the tab is hidden).

**Why:** the data is already aggregate (counts, buckets); a WebSocket fan-out layer would add server state, reconnect logic, and auth plumbing to save a few kilobytes per poll. Polling is stateless, cache-friendly, works through any proxy, and its staleness bound is explicit. The API shape wouldn't change if WS were added later — it would push the same JSON.

## 10. No ORM: SQL + a 60-line data layer

**Decision:** hand-written SQL through `pg`, with tiny helpers (`q`, `qOne`, `withTx`, snake→camel mapping) and a hand-rolled migration runner.

**Why:** the value of this system *is* its SQL — `SKIP LOCKED`, partial indexes, `ON CONFLICT` idempotency, `FILTER` aggregates, advisory locks. An ORM would hide exactly the parts that matter (and make some, like the claim statement, impossible to express). Migrations are plain `.sql` files applied in order and recorded — evaluators read the schema in one file rather than reverse-engineering it from model classes.

## 11. Validation at the edge with zod; enums and CHECKs in the database

**Decision:** every request body/query is parsed by a zod schema (yielding structured `details` in 400s); the same invariants exist as Postgres enums and CHECK constraints.

**Why:** edge validation gives good errors; storage validation makes bad states unrepresentable even if a code path slips. The duplication is cheap and intentional — the DB constraint is the last line of defense, not the UX.

## 12. Monorepo with npm workspaces; TypeScript everywhere

**Decision:** `server/` + `web/` in one repo, one `npm install`, strict TS on both sides.

**Why:** one language across API, worker, and UI; one toolchain for the evaluator; shared conventions (the dashboard's types mirror the API's camelCase JSON). Runtime dependencies are deliberately few (express, pg, zod, jsonwebtoken, bcryptjs, cron-parser); the dashboard uses zero UI libraries (hand-rolled components + SVG charts) to keep the build small and the code inspectable.

## Known limitations (deliberate scope)

- **No running-job cancellation** — cancel covers pending jobs; killing in-flight handlers needs cooperative abort plumbing per handler. The `AbortSignal` is already threaded through, so this is an extension point, not a redesign.
- **Workflow dependencies (DAGs) not implemented** — chosen against, in favor of depth on reliability; the schema extension (a `job_dependencies` edge table + a `waiting` state promoted by the scheduler) is straightforward.
- **Metrics are computed on read** — fine at this scale (indexed, windowed queries); counter caches/rollups are the documented growth path.
- **Single-region, single-DB** — leases and clocks assume one Postgres; multi-region would need per-region queues or a different coordination story.
