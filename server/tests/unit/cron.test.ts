import { describe, expect, it } from "vitest";
import { cronValidationError, nextCronRun } from "../../src/core/cron";

describe("nextCronRun", () => {
  it("computes the next minute boundary for * * * * *", () => {
    const from = new Date("2026-01-15T10:30:20Z");
    expect(nextCronRun("* * * * *", "UTC", from).toISOString()).toBe(
      "2026-01-15T10:31:00.000Z",
    );
  });

  it("computes hourly and daily schedules", () => {
    const from = new Date("2026-01-15T10:30:00Z");
    expect(nextCronRun("0 * * * *", "UTC", from).toISOString()).toBe(
      "2026-01-15T11:00:00.000Z",
    );
    expect(nextCronRun("30 2 * * *", "UTC", from).toISOString()).toBe(
      "2026-01-16T02:30:00.000Z",
    );
  });

  it("respects timezones", () => {
    // 09:00 New York (EST, UTC-5) == 14:00 UTC in January.
    const from = new Date("2026-01-15T10:00:00Z");
    expect(nextCronRun("0 9 * * *", "America/New_York", from).toISOString()).toBe(
      "2026-01-15T14:00:00.000Z",
    );
  });

  it("is strictly after `from`", () => {
    const from = new Date("2026-01-15T10:31:00.000Z");
    expect(nextCronRun("* * * * *", "UTC", from).getTime()).toBeGreaterThan(from.getTime());
  });
});

describe("cronValidationError", () => {
  it("accepts valid expressions", () => {
    expect(cronValidationError("*/5 * * * *")).toBeNull();
    expect(cronValidationError("0 9 * * 1-5", "Asia/Kolkata")).toBeNull();
  });

  it("rejects malformed expressions", () => {
    expect(cronValidationError("not a cron")).toBeTruthy();
    expect(cronValidationError("99 * * * *")).toBeTruthy();
  });

  it("rejects unknown timezones", () => {
    expect(cronValidationError("* * * * *", "Mars/Olympus_Mons")).toBeTruthy();
  });
});
