# Codity — Distributed Job Scheduler

A production-inspired distributed job scheduling platform: REST API + PostgreSQL-backed queue engine + horizontally scalable workers + live web dashboard.

![stack](https://img.shields.io/badge/stack-TypeScript%20·%20Node%2020%20·%20PostgreSQL%2016%20·%20Express%20·%20React-blue)

**⭐ GitHub Repository:** **[github.com/aditya-bagret/Codity.ai](https://github.com/aditya-bagret/Codity.ai.git)**

## What it does

- **Auth & multi-tenancy** — users, organizations with role-based access (owner / admin / member), projects, per-project API keys for programmatic access.
- **Queues** — per-queue priority, global max-concurrency, per-second rate limits, pause/resume, default timeouts, configurable retry policies, live statistics.
- **Jobs** — immediate, delayed (`delayMs` / `runAt`), recurring (cron with timezones), and batch creation through REST. Idempotency keys give exactly-once enqueue.
- **Workers** — poll queues by priority, **claim jobs atomically** (`FOR UPDATE SKIP LOCKED` + per-queue advisory locks), execute concurrently with per-job timeouts, heartbeat, and drain gracefully on `SIGTERM`.
- **Full lifecycle** — `scheduled → queued → claimed → running → completed`, with retries (fixed / linear / exponential backoff + jitter) and a **dead letter queue** for permanent failures.
- **Reliability** — lease-based fencing, heartbeat liveness detection, automatic requeue of jobs from dead/hung workers, scheduler leader election via Postgres advisory locks, at-least-once execution semantics.
- **Observability** — per-attempt execution history, structured job logs, worker assignment audit trail, progress reporting, throughput/duration metrics.
- **Dashboard** — React SPA with live-polling overview (throughput chart, queue health), job explorer with filters, job detail with retry timeline + logs, worker monitor, DLQ management (retry / discard / retry-all), queue configuration.
- **Bonus** — distributed locking (advisory locks), per-queue rate limiting, role-based access control.

## Quickstart

Prerequisites: **Node 20+** and either **Docker** or a local **PostgreSQL 14+**.

```bash
# 1. Database — pick ONE:
docker compose up -d               # Postgres 16 on localhost:5433 (recommended)
# ...or point DATABASE_URL at any Postgres and create a `codity` database.

# 2. Install, migrate, seed demo data
npm install
npm run setup                      # applies migrations + seeds a demo workspace

# 3. Run (three terminals)
npm run dev                        # API + dashboard on http://localhost:4000
npm run worker                     # worker (start as many as you like)
npm run web                        # OPTIONAL: Vite dev server on :5173 (hot reload)
```

Then open **http://localhost:4000** (after `npm run build`, the API serves the dashboard; during development use :5173) and log in:

```
email:    demo@codity.dev
password: demo1234
```

Finally, generate some traffic and watch the dashboard move:

```bash
npm run demo                       # enqueues ~80 mixed jobs (some intentionally fail)
```

### About demo failures (expected, not bugs)

The seed data and `npm run demo` deliberately enqueue jobs that **fail by design** so you can see retries, the dead letter queue, and recovery in action. Red failure counts after running the demo are normal.

| Source | Job type | What happens |
|---|---|---|
| Seed | `demo.fail` | Always throws → exhausts retries → DLQ (`corrupt input file (demo DLQ entry)`) |
| `npm run demo` | `email.send` to `not-an-address` | Validation fails every attempt → DLQ |
| `npm run demo` | `demo.flaky` | ~60% failure rate per attempt; most succeed after retries |
| `npm run demo` | `email.send` / `webhook.dispatch` | ~5–8% simulated transient errors that usually retry successfully |

The dashboard overview shows a yellow callout when failures or DLQ entries are present, explaining that these come from the demo workload.

> The dashboard is pre-built? If `web/dist` is missing, run `npm run build` once to serve the SPA from :4000, or just use `npm run web` for the dev server.

Multiple workers: run `npm run worker` in additional terminals (optionally `WORKER_NAME=w2 WORKER_QUEUES=emails,webhooks npm run worker`). Kill one with `Ctrl+C` to watch graceful draining; `kill -9` one mid-job to watch the reaper recover its jobs.

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | Migrate + seed (idempotent) |
| `npm run dev` | API server with reload (`:4000`) |
| `npm run worker` | Start a worker process |
| `npm run web` | Dashboard dev server (`:5173`, proxies `/api`) |
| `npm run demo` | Enqueue a burst of demo jobs |
| `npm run build` | Build the dashboard into `web/dist` |
| `npm test` | Full test suite (unit + integration; needs Postgres) |
| `npm run test:unit` | DB-free unit tests only |
| `npm run typecheck` | TypeScript across server and web |

## Configuration

All settings come from environment variables (or a root `.env`; see [.env.example](.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://codity:codity@localhost:5433/codity` | Postgres connection |
| `PORT` | `4000` | API port |
| `JWT_SECRET` | dev default (warns) | Token signing secret |
| `WORKER_CONCURRENCY` | `5` | Max parallel jobs per worker |
| `WORKER_POLL_INTERVAL_MS` | `750` | Poll cadence when idle |
| `WORKER_HEARTBEAT_MS` | `5000` | Heartbeat cadence |
| `WORKER_QUEUES` | *(all)* | Comma-separated queue subscription filter |
| `SCHEDULER_TICK_MS` | `1000` | Scheduler cadence (promotion, cron, reaping) |
| `DEAD_WORKER_AFTER_MS` | `20000` | Missed-heartbeat window before a worker is declared dead |

## Testing

```bash
npm test          # 55 tests: atomic claiming under contention, concurrency caps,
                  # rate limits, retry → DLQ lifecycle, reaper/lease recovery,
                  # cron materialization, auth/RBAC, validation, pagination,
                  # idempotency, and a real worker end-to-end (incl. graceful drain)
```

Integration tests run against a disposable `codity_test` database that is recreated on every run. `npm run test:unit` (backoff math, cron parsing) needs no database.

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System components, job state machine, atomic claiming design, scheduler leader election, failure model |
| [docs/database.md](docs/database.md) | ER diagram, per-table rationale, keys/indexes/cascades, performance notes |
| [docs/api.md](docs/api.md) | Full REST reference with examples, auth, errors, pagination |
| [docs/design-decisions.md](docs/design-decisions.md) | The major trade-offs and why they were made |

## Repository layout

```
├── server/
│   ├── src/
│   │   ├── api/            # Express routes, auth middleware, validation (zod)
│   │   ├── core/           # claim, lifecycle, scheduler, retry, cron, stats
│   │   ├── db/             # pool, migration runner, migrations/, seed, demo
│   │   ├── jobs/           # job handler registry (demo handlers)
│   │   └── worker/         # worker service (executor pool, heartbeats, drain)
│   └── tests/              # vitest unit + integration suites
├── web/                    # React dashboard (Vite, zero UI dependencies)
├── docs/                   # architecture, ER/database, API, design decisions
└── docker-compose.yml      # PostgreSQL 16
```

## Assignment coverage

| Requirement | Where |
|---|---|
| Authentication & project management | `server/src/api/routes/{auth,orgs,projects}.ts` |
| Queue config: priority, concurrency, retry policy, pause/resume, stats | `routes/queues.ts`, `core/claim.ts`, `core/stats.ts` |
| Immediate / delayed / scheduled / recurring / batch jobs | `routes/{jobs,schedules}.ts`, `core/jobs.ts`, `core/scheduler.ts` |
| Worker service: polling, atomic claim, concurrency, heartbeats, graceful shutdown | `worker/index.ts`, `core/claim.ts`, `core/workers.ts` |
| Lifecycle with retries + DLQ | `core/jobs.ts` (`failExecution`), migration `001_initial.sql` |
| Retry strategies: fixed / linear / exponential | `core/retry.ts` |
| Execution logs, retry history, worker assignment, metrics | `job_executions`, `job_logs` tables; `core/stats.ts` |
| Web dashboard with live updates | `web/src/**` (polling) |
| Bonus: distributed locking, rate limiting, RBAC | advisory locks in `core/{claim,scheduler}.ts`; `remainingRateBudget` in `core/claim.ts`; `api/access.ts` |
