import { qOne, type Db } from "../db/pool";
import { ApiError } from "../lib/errors";
import type { Job, OrgRole, Queue } from "../types";
import type { AuthContext } from "./middleware";

const RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };

/**
 * The caller's role on a project, or null if they have none. API-key callers
 * get member rights on exactly their own project.
 */
export async function projectRole(
  db: Db,
  auth: AuthContext,
  projectId: string,
): Promise<OrgRole | null> {
  if (auth.apiKeyProjectId) {
    return auth.apiKeyProjectId === projectId ? "member" : null;
  }
  if (!auth.userId) return null;
  const row = await qOne<{ role: OrgRole }>(
    db,
    `SELECT m.role FROM organization_members m
     JOIN projects p ON p.organization_id = m.organization_id
     WHERE p.id = $1 AND m.user_id = $2`,
    [projectId, auth.userId],
  );
  return row?.role ?? null;
}

/**
 * Enforces a minimum role. Non-members get 404 (existence is not leaked),
 * members below the required role get 403.
 */
export async function requireProjectRole(
  db: Db,
  auth: AuthContext,
  projectId: string,
  min: OrgRole,
): Promise<OrgRole> {
  const role = await projectRole(db, auth, projectId);
  if (!role) throw ApiError.notFound("project");
  if (RANK[role] < RANK[min]) {
    throw ApiError.forbidden(`this action requires the ${min} role`);
  }
  return role;
}

export async function orgRole(db: Db, auth: AuthContext, orgId: string): Promise<OrgRole | null> {
  if (!auth.userId) return null;
  const row = await qOne<{ role: OrgRole }>(
    db,
    "SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    [orgId, auth.userId],
  );
  return row?.role ?? null;
}

export async function requireOrgRole(
  db: Db,
  auth: AuthContext,
  orgId: string,
  min: OrgRole,
): Promise<OrgRole> {
  const role = await orgRole(db, auth, orgId);
  if (!role) throw ApiError.notFound("organization");
  if (RANK[role] < RANK[min]) {
    throw ApiError.forbidden(`this action requires the ${min} role`);
  }
  return role;
}

/** Loads a queue and authorizes the caller against its project in one step. */
export async function getQueueChecked(
  db: Db,
  auth: AuthContext,
  queueId: string,
  min: OrgRole = "member",
): Promise<Queue> {
  const queue = await qOne<Queue>(db, "SELECT * FROM queues WHERE id = $1", [queueId]);
  if (!queue) throw ApiError.notFound("queue");
  await requireProjectRole(db, auth, queue.projectId, min);
  return queue;
}

/** Loads a job (with its project id) and authorizes the caller. */
export async function getJobChecked(
  db: Db,
  auth: AuthContext,
  jobId: string,
  min: OrgRole = "member",
): Promise<{ job: Job; projectId: string; queueName: string }> {
  const row = await qOne<Job & { projectId: string; queueName: string }>(
    db,
    `SELECT j.*, q.project_id, q.name AS queue_name
     FROM jobs j JOIN queues q ON q.id = j.queue_id
     WHERE j.id = $1`,
    [jobId],
  );
  if (!row) throw ApiError.notFound("job");
  await requireProjectRole(db, auth, row.projectId, min);
  const { projectId, queueName, ...job } = row;
  return { job: job as Job, projectId, queueName };
}
