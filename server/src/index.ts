import { createApp } from "./api/app";
import { config } from "./config";
import { closePool } from "./db/pool";
import { logger } from "./logger";

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info(`API listening on http://localhost:${config.port}`);
  if (config.jwtSecret === "dev-secret-do-not-use-in-production") {
    logger.warn("using default JWT_SECRET — set JWT_SECRET in production");
  }
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — closing API server`);
  server.close(() => {
    void closePool().then(() => process.exit(0));
  });
  // Fallback if keep-alive connections refuse to die.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
