import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config";
import { pool, qOne } from "../db/pool";
import { ApiError } from "../lib/errors";
import { logger } from "../logger";

/**
 * Who is calling: a dashboard user (JWT) or an integration (project API key).
 * API-key callers act with member-level rights scoped to their one project.
 */
export interface AuthContext {
  userId: string | null;
  apiKeyProjectId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth: AuthContext;
      requestId: string;
    }
  }
}

/** Wraps async handlers so rejections reach the error middleware. */
export function ah(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Assigns a request id and emits one structured log line per request. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = (req.header("x-request-id") ?? randomUUID()).slice(0, 64);
  res.setHeader("x-request-id", req.requestId);
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info("request", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      requestId: req.requestId,
      userId: req.auth?.userId ?? undefined,
    });
  });
  next();
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, {
    expiresIn: `${config.jwtExpiresDays}d`,
  });
}

/** Authenticates via `Authorization: Bearer <jwt>` or `X-Api-Key: <key>`. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    const header = req.header("authorization");
    if (header?.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(header.slice(7), config.jwtSecret) as { sub?: string };
        if (!payload.sub) throw new Error("missing sub");
        const user = await qOne(pool, "SELECT id FROM users WHERE id = $1", [payload.sub]);
        if (!user) throw new Error("user gone");
        req.auth = { userId: payload.sub, apiKeyProjectId: null };
        return next();
      } catch {
        return next(ApiError.unauthorized("invalid or expired token"));
      }
    }
    const apiKey = req.header("x-api-key");
    if (apiKey) {
      const project = await qOne<{ id: string }>(pool, "SELECT id FROM projects WHERE api_key = $1", [
        apiKey,
      ]);
      if (!project) return next(ApiError.unauthorized("invalid API key"));
      req.auth = { userId: null, apiKeyProjectId: project.id };
      return next();
    }
    next(ApiError.unauthorized());
  })().catch(next);
};

/** Validates and replaces req.body / req.query with the parsed value. */
export function validate(schema: z.ZodTypeAny, source: "body" | "query" = "body"): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(
        ApiError.validation(`invalid request ${source}`, result.error.flatten().fieldErrors),
      );
    }
    (req as unknown as Record<string, unknown>)[source] = result.data;
    next();
  };
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound("endpoint"));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
    });
    return;
  }
  // Map common Postgres constraint violations to friendly API errors.
  const pgCode = (err as { code?: string }).code;
  if (pgCode === "23505") {
    res.status(409).json({
      error: { code: "CONFLICT", message: "a resource with that identity already exists" },
    });
    return;
  }
  if (pgCode === "23503") {
    res.status(400).json({
      error: { code: "BAD_REQUEST", message: "referenced resource does not exist" },
    });
    return;
  }
  logger.error("unhandled API error", {
    err: err as Error,
    path: req.originalUrl,
    requestId: req.requestId,
  });
  res.status(500).json({
    error: { code: "INTERNAL", message: "internal server error", requestId: req.requestId },
  });
}

/** Standard pagination envelope. */
export interface Page<T> {
  data: T[];
  pagination: { total: number; limit: number; offset: number };
}

export function page<T>(data: T[], total: number, limit: number, offset: number): Page<T> {
  return { data, pagination: { total, limit, offset } };
}
