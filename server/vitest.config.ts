import { defineConfig } from "vitest/config";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://codity:codity@localhost:5433/codity_test";

export default defineConfig({
  test: {
    globalSetup: ["tests/setup/global.ts"],
    env: {
      DATABASE_URL: TEST_DB_URL,
      LOG_LEVEL: "error",
      SCHEDULER_TICK_MS: "200",
      JWT_SECRET: "test-secret",
    },
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
