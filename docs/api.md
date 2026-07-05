# REST API Reference

Base URL: `http://localhost:4000/api`

## Authentication

Two credential types; every endpoint except `POST /auth/register`, `POST /auth/login`, `GET /health`, and `GET /meta` requires one of them.

| Type | Header | Scope |
|---|---|---|
| **User JWT** | `Authorization: Bearer <token>` | Everything the user's org roles allow |
| **Project API key** | `X-Api-Key: ck_…` | One project, member-level rights (create/read/retry jobs — no config changes, no org/user endpoints) |

Roles rank `owner > admin > member`. Reads need `member`; queue/policy/schedule configuration and DLQ discard need `admin`; project deletion and API-key visibility need `admin`/`owner`. Non-members receive `404` (existence is not leaked); insufficient role receives `403`.

## Conventions

- **Errors** are always `{ "error": { "code", "message", "details?" } }`. Codes: `VALIDATION_ERROR`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INTERNAL`.
- **Pagination**: list endpoints take `?limit=` (1–100, default 25) and `?offset=`, and return `{ "data": [...], "pagination": { "total", "limit", "offset" } }`.
- **Request IDs**: every response carries `x-request-id` (also accepted inbound) and appears in server logs.
- Timestamps are ISO-8601 UTC. Job `priority` is higher-runs-first (−100…100).

---

## Auth

| Method & path | Body | Notes |
|---|---|---|
| `POST /auth/register` | `{ email, password (≥8), name, orgName? }` | Creates user + personal org (owner). → `201 { token, user }` |
| `POST /auth/login` | `{ email, password }` | → `{ token, user }`; email case-insensitive |
| `GET /auth/me` | — | Current user |

## Organizations

| Method & path | Role | Notes |
|---|---|---|
| `GET /orgs` | user | My orgs with role + member count |
| `POST /orgs` | user | `{ name }` → new org, caller becomes owner |
| `GET /orgs/:orgId/members` | member | List members |
| `POST /orgs/:orgId/members` | admin | `{ email, role: "admin"\|"member" }` — user must exist; upserts role |
| `DELETE /orgs/:orgId/members/:userId` | admin | Owner cannot be removed |

## Projects

| Method & path | Role | Notes |
|---|---|---|
| `GET /projects` | any | User: all projects across orgs. API key: exactly its own project |
| `POST /projects` | org admin | `{ organizationId, name }` — generates an API key |
| `GET /projects/:id` | member | `apiKey` is `null` unless caller is admin+ |
| `DELETE /projects/:id` | owner | Cascades queues/jobs/history |
| `POST /projects/:id/rotate-api-key` | admin | → `{ apiKey }` |
| `GET /projects/:id/overview` | member | Dashboard rollup: worker counts, 24h totals, success rate, backlog, DLQ, 60-min throughput, per-queue health, recent failures |
| `GET /projects/:id/dlq` | member | Project-wide DLQ listing (`?status=pending\|retried\|discarded`) |

## Retry policies

| Method & path | Role | Notes |
|---|---|---|
| `GET /projects/:id/retry-policies` | member | |
| `POST /projects/:id/retry-policies` | admin | `{ name, strategy: "fixed"\|"linear"\|"exponential", maxRetries 0–20, baseDelayMs, maxDelayMs ≥ base, jitter }` |
| `PATCH /retry-policies/:id` | admin | Partial update (existing jobs keep their snapshot) |
| `DELETE /retry-policies/:id` | admin | Queues referencing it fall back to platform default |

## Queues

| Method & path | Role | Notes |
|---|---|---|
| `GET /projects/:id/queues` | member | Includes live `queued` / `running` / `scheduled` counts |
| `POST /projects/:id/queues` | admin | `{ name, description?, priority?, maxConcurrency?, rateLimitPerSec?, defaultTimeoutMs?, retryPolicyId? }` |
| `GET /queues/:id` | member | Queue + resolved retry policy |
| `PATCH /queues/:id` | admin | Any config field above |
| `POST /queues/:id/pause` / `/resume` | admin | Paused queues accept jobs but workers skip them |
| `DELETE /queues/:id` | admin | `409` while jobs are running |
| `GET /queues/:id/stats` | member | Status counts, DLQ pending, oldest-queued age, 60-min throughput buckets, duration avg/p50/p95, 24h success rate |

## Jobs

### Create

```bash
curl -X POST localhost:4000/api/queues/$QUEUE/jobs \
  -H "X-Api-Key: $KEY" -H 'content-type: application/json' \
  -d '{
    "type": "email.send",
    "payload": { "to": "a@b.co", "subject": "Hi" },
    "priority": 5,
    "delayMs": 60000,
    "retries": 2,
    "timeoutMs": 30000,
    "idempotencyKey": "order-42-confirmation"
  }'
```

- Exactly one of `delayMs` / `runAt` (ISO date) may be given; omit both for immediate.
- Retry resolution: explicit `retryPolicyId` (must belong to the project) → queue's policy → platform default (exponential ×3, 1 s base, 60 s cap, jitter); `retries` overrides just the count.
- → `201 { job, deduped: false }`. A repeated `idempotencyKey` on the same queue returns `200` with the **existing** job and `deduped: true`.

### Batch

`POST /queues/:id/jobs/batch` — `{ name?, jobs: [ {type, payload?, priority?, delayMs?, retries?, idempotencyKey?, timeoutMs?}, … ] }` (1–1000 jobs, single transaction) → `201 { batch, created, requested, jobs }`. Progress: `GET /batches/:batchId` → per-status counts.

### Inspect & act

| Method & path | Notes |
|---|---|
| `GET /queues/:id/jobs?status=queued,running&type=email.send&search=…&limit&offset` | `status` is a comma list; `search` matches id / type / idempotency key |
| `GET /jobs/:id` | Job + queue name + full execution history (worker, timing, error, result) + pending DLQ entry + batch progress |
| `GET /jobs/:id/logs` | Structured logs; `executionId: null` rows are lifecycle events |
| `POST /jobs/:id/cancel` | Only `scheduled`/`queued` → else `409` |
| `POST /jobs/:id/retry` | `{ extraAttempts? = 1 }` — re-queues a `failed`/`cancelled`/`completed` job, resolves its DLQ entry |

## Recurring schedules (cron)

| Method & path | Role | Notes |
|---|---|---|
| `GET /queues/:id/schedules` | member | |
| `POST /queues/:id/schedules` | admin | `{ name, cronExpression, timezone? = "UTC", jobType, payload?, priority? }` — cron validated server-side (5-field, tz-aware) |
| `PATCH /schedules/:id` | admin | Any field + `isActive`; timing changes recompute `nextRunAt` |
| `POST /schedules/:id/trigger` | member | Fire once immediately (does not shift the cadence) |
| `DELETE /schedules/:id` | admin | Past jobs keep a nulled origin reference |

## Workers (read-only monitoring)

| Method & path | Notes |
|---|---|
| `GET /workers` | Fleet with status (`online/draining/offline/dead`), in-flight count, 1h completed/failed, queue filter, heartbeat age |
| `GET /workers/:id` | + last ~10 min of heartbeats (for load sparkline) and currently held jobs |

## Dead letter queue

| Method & path | Role | Notes |
|---|---|---|
| `GET /queues/:id/dlq?status=` | member | Self-contained entries (type, payload snapshot, reason, attempts) |
| `POST /dlq/:id/retry` | member | Re-drives the underlying job; entry → `retried` |
| `POST /dlq/:id/discard` | admin | Entry → `discarded` |
| `POST /queues/:id/dlq/retry-all` | admin | Bulk re-drive of pending entries |

## Meta

| Method & path | Notes |
|---|---|
| `GET /health` | `{ status, db }` — `503` if Postgres unreachable |
| `GET /meta` | Registered job types (with sample payloads — drives the dashboard's create form) |

## Error example

```json
HTTP 400
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "invalid request body",
    "details": { "type": ["Required"], "priority": ["Number must be ≤ 100"] }
  }
}
```
