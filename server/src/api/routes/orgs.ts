import { Router } from "express";
import { pool, q, qOne, withTx } from "../../db/pool";
import { ApiError } from "../../lib/errors";
import { requireOrgRole } from "../access";
import { ah, validate } from "../middleware";
import { addMemberBody, createOrgBody } from "../schemas";

export const orgsRouter = Router();

function requireUser(req: { auth: { userId: string | null } }): string {
  if (!req.auth.userId) throw ApiError.forbidden("API keys cannot manage organizations");
  return req.auth.userId;
}

orgsRouter.get(
  "/orgs",
  ah(async (req, res) => {
    const userId = requireUser(req);
    const orgs = await q(
      pool,
      `SELECT o.id, o.name, o.created_at, m.role,
         (SELECT count(*)::int FROM organization_members mm WHERE mm.organization_id = o.id) AS members
       FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id AND m.user_id = $1
       ORDER BY o.created_at`,
      [userId],
    );
    res.json({ data: orgs });
  }),
);

orgsRouter.post(
  "/orgs",
  validate(createOrgBody),
  ah(async (req, res) => {
    const userId = requireUser(req);
    const { name } = req.body as { name: string };
    const org = await withTx(async (tx) => {
      const o = (
        await q<{ id: string; name: string }>(
          tx,
          "INSERT INTO organizations (name) VALUES ($1) RETURNING id, name, created_at",
          [name],
        )
      )[0];
      await tx.query(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
        [o.id, userId],
      );
      return o;
    });
    res.status(201).json({ organization: org });
  }),
);

orgsRouter.get(
  "/orgs/:orgId/members",
  ah(async (req, res) => {
    requireUser(req);
    await requireOrgRole(pool, req.auth, req.params.orgId, "member");
    const members = await q(
      pool,
      `SELECT u.id, u.email, u.name, m.role, m.created_at
       FROM organization_members m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1
       ORDER BY m.created_at`,
      [req.params.orgId],
    );
    res.json({ data: members });
  }),
);

orgsRouter.post(
  "/orgs/:orgId/members",
  validate(addMemberBody),
  ah(async (req, res) => {
    requireUser(req);
    await requireOrgRole(pool, req.auth, req.params.orgId, "admin");
    const { email, role } = req.body as { email: string; role: "admin" | "member" };
    const user = await qOne<{ id: string }>(
      pool,
      "SELECT id FROM users WHERE lower(email) = lower($1)",
      [email],
    );
    if (!user) throw ApiError.notFound("user with that email");
    await pool.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [req.params.orgId, user.id, role],
    );
    res.status(201).json({ added: { userId: user.id, role } });
  }),
);

orgsRouter.delete(
  "/orgs/:orgId/members/:userId",
  ah(async (req, res) => {
    requireUser(req);
    await requireOrgRole(pool, req.auth, req.params.orgId, "admin");
    const target = await qOne<{ role: string }>(
      pool,
      "SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2",
      [req.params.orgId, req.params.userId],
    );
    if (!target) throw ApiError.notFound("member");
    if (target.role === "owner") throw ApiError.forbidden("the owner cannot be removed");
    await pool.query(
      "DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2",
      [req.params.orgId, req.params.userId],
    );
    res.json({ removed: true });
  }),
);
