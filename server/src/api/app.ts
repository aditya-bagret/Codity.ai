import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  errorHandler,
  notFoundHandler,
  requestContext,
  requireAuth,
} from "./middleware";
import { authRouter } from "./routes/auth";
import { dlqRouter } from "./routes/dlq";
import { jobsRouter } from "./routes/jobs";
import { metaRouter } from "./routes/meta";
import { orgsRouter } from "./routes/orgs";
import { projectsRouter } from "./routes/projects";
import { queuesRouter } from "./routes/queues";
import { schedulesRouter } from "./routes/schedules";
import { workersRouter } from "./routes/workers";

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(requestContext);

  // Public: health, meta, and auth (register/login).
  app.use("/api", metaRouter);
  app.use("/api/auth", authRouter);

  // Everything else requires a JWT or project API key.
  const authed = express.Router();
  authed.use(requireAuth);
  authed.use(orgsRouter);
  authed.use(projectsRouter);
  authed.use(queuesRouter);
  authed.use(jobsRouter);
  authed.use(schedulesRouter);
  authed.use(workersRouter);
  authed.use(dlqRouter);
  app.use("/api", authed);

  app.use("/api", notFoundHandler);

  // Serve the built dashboard (single-port deployment) when web/dist exists.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use(errorHandler);
  return app;
}
