import { closePool } from "../db/pool";
import { logger } from "../logger";
import { Worker } from "./index";

const worker = new Worker({ runScheduler: true });
await worker.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — starting graceful shutdown`);
  await worker.stop();
  await closePool();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
