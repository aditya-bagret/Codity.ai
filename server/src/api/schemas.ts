import { z } from "zod";

// --- shared -----------------------------------------------------------------

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const name = z.string().trim().min(1).max(100);
const slugName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-_]*$/i, "letters, digits, hyphens and underscores only");

// --- auth -------------------------------------------------------------------

export const registerBody = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
  name,
  orgName: name.optional(),
});

export const loginBody = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

// --- orgs / projects --------------------------------------------------------

export const createOrgBody = z.object({ name });

export const addMemberBody = z.object({
  email: z.string().trim().email(),
  role: z.enum(["admin", "member"]).default("member"),
});

export const createProjectBody = z.object({
  organizationId: z.string().uuid(),
  name,
});

// --- retry policies ----------------------------------------------------------

export const retryPolicyBody = z
  .object({
    name: slugName,
    strategy: z.enum(["fixed", "linear", "exponential"]).default("exponential"),
    maxRetries: z.number().int().min(0).max(20).default(3),
    baseDelayMs: z.number().int().min(10).max(3_600_000).default(1000),
    maxDelayMs: z.number().int().min(10).max(3_600_000).default(60_000),
    jitter: z.boolean().default(true),
  })
  .refine((p) => p.maxDelayMs >= p.baseDelayMs, {
    message: "maxDelayMs must be >= baseDelayMs",
    path: ["maxDelayMs"],
  });

export const retryPolicyPatch = z
  .object({
    name: slugName.optional(),
    strategy: z.enum(["fixed", "linear", "exponential"]).optional(),
    maxRetries: z.number().int().min(0).max(20).optional(),
    baseDelayMs: z.number().int().min(10).max(3_600_000).optional(),
    maxDelayMs: z.number().int().min(10).max(3_600_000).optional(),
    jitter: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: "no fields to update" });

// --- queues -------------------------------------------------------------------

export const createQueueBody = z.object({
  name: slugName,
  description: z.string().trim().max(500).optional(),
  priority: z.number().int().min(-100).max(100).default(0),
  maxConcurrency: z.number().int().min(1).max(1000).default(5),
  rateLimitPerSec: z.number().int().min(1).max(10_000).nullable().optional(),
  defaultTimeoutMs: z.number().int().min(1000).max(1_800_000).default(60_000),
  retryPolicyId: z.string().uuid().nullable().optional(),
});

export const patchQueueBody = z
  .object({
    name: slugName.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    maxConcurrency: z.number().int().min(1).max(1000).optional(),
    rateLimitPerSec: z.number().int().min(1).max(10_000).nullable().optional(),
    defaultTimeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
    retryPolicyId: z.string().uuid().nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: "no fields to update" });

// --- jobs ---------------------------------------------------------------------

const jobCore = {
  type: z.string().trim().min(1).max(200),
  payload: z.unknown().optional(),
  priority: z.number().int().min(-100).max(100).default(0),
  retries: z.number().int().min(0).max(20).optional(),
  retryPolicyId: z.string().uuid().optional(),
  timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
};

export const createJobBody = z
  .object({
    ...jobCore,
    /** Relative delay; mutually exclusive with runAt. */
    delayMs: z.number().int().min(0).max(365 * 24 * 3_600_000).optional(),
    /** Absolute schedule time (ISO 8601). */
    runAt: z.coerce.date().optional(),
  })
  .refine((j) => !(j.delayMs !== undefined && j.runAt !== undefined), {
    message: "provide either delayMs or runAt, not both",
    path: ["runAt"],
  });

export const createBatchBody = z.object({
  name: z.string().trim().max(100).optional(),
  jobs: z
    .array(
      z.object({
        ...jobCore,
        delayMs: z.number().int().min(0).max(365 * 24 * 3_600_000).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

export const listJobsQuery = paginationQuery.extend({
  status: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(
      z.array(
        z.enum(["scheduled", "queued", "claimed", "running", "completed", "failed", "cancelled"]),
      ),
    )
    .optional(),
  type: z.string().trim().max(200).optional(),
  search: z.string().trim().max(200).optional(),
});

export const retryJobBody = z.object({
  extraAttempts: z.number().int().min(1).max(20).default(1),
});

// --- schedules -----------------------------------------------------------------

export const createScheduleBody = z.object({
  name: slugName,
  cronExpression: z.string().trim().min(1).max(100),
  timezone: z.string().trim().max(64).default("UTC"),
  jobType: z.string().trim().min(1).max(200),
  payload: z.unknown().optional(),
  priority: z.number().int().min(-100).max(100).default(0),
});

export const patchScheduleBody = z
  .object({
    name: slugName.optional(),
    cronExpression: z.string().trim().min(1).max(100).optional(),
    timezone: z.string().trim().max(64).optional(),
    jobType: z.string().trim().min(1).max(200).optional(),
    payload: z.unknown().optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: "no fields to update" });

// --- dlq ------------------------------------------------------------------------

export const listDlqQuery = paginationQuery.extend({
  status: z.enum(["pending", "retried", "discarded"]).optional(),
});
