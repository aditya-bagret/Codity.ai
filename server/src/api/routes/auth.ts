import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool, q, qOne, withTx } from "../../db/pool";
import { ApiError } from "../../lib/errors";
import { ah, requireAuth, signToken, validate } from "../middleware";
import { loginBody, registerBody } from "../schemas";
import type { User } from "../../types";

export const authRouter = Router();

/**
 * Registration creates the user plus a personal organization they own, so a
 * fresh account can immediately create projects and queues.
 */
authRouter.post(
  "/register",
  validate(registerBody),
  ah(async (req, res) => {
    const { email, password, name, orgName } = req.body as {
      email: string;
      password: string;
      name: string;
      orgName?: string;
    };
    const existing = await qOne(pool, "SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
    if (existing) throw ApiError.conflict("an account with that email already exists");

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await withTx(async (tx) => {
      const u = (
        await q<User>(
          tx,
          "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at",
          [email, passwordHash, name],
        )
      )[0];
      const org = (
        await q<{ id: string }>(tx, "INSERT INTO organizations (name) VALUES ($1) RETURNING id", [
          orgName ?? `${name}'s Org`,
        ])
      )[0];
      await tx.query(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
        [org.id, u.id],
      );
      return u;
    });

    res.status(201).json({ token: signToken(user.id), user });
  }),
);

authRouter.post(
  "/login",
  validate(loginBody),
  ah(async (req, res) => {
    const { email, password } = req.body as { email: string; password: string };
    const user = await qOne<User & { passwordHash: string }>(
      pool,
      "SELECT id, email, name, created_at, password_hash FROM users WHERE lower(email) = lower($1)",
      [email],
    );
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw ApiError.unauthorized("invalid email or password");
    }
    const { passwordHash: _ph, ...safe } = user;
    res.json({ token: signToken(user.id), user: safe });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  ah(async (req, res) => {
    if (!req.auth.userId) throw ApiError.forbidden("API keys cannot access user endpoints");
    const user = await qOne<User>(
      pool,
      "SELECT id, email, name, created_at FROM users WHERE id = $1",
      [req.auth.userId],
    );
    if (!user) throw ApiError.notFound("user");
    res.json({ user });
  }),
);
