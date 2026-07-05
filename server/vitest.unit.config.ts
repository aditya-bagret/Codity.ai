import { defineConfig } from "vitest/config";

/** DB-free unit tests only (no Postgres required). */
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
