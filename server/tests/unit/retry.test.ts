import { describe, expect, it } from "vitest";
import { computeBackoffMs } from "../../src/core/retry";

const base = { baseDelayMs: 1000, maxDelayMs: 60_000, jitter: false };

describe("computeBackoffMs", () => {
  it("fixed strategy returns the base delay for every attempt", () => {
    const snap = { ...base, strategy: "fixed" as const };
    expect(computeBackoffMs(snap, 1)).toBe(1000);
    expect(computeBackoffMs(snap, 5)).toBe(1000);
    expect(computeBackoffMs(snap, 20)).toBe(1000);
  });

  it("linear strategy grows proportionally to the attempt number", () => {
    const snap = { ...base, strategy: "linear" as const };
    expect(computeBackoffMs(snap, 1)).toBe(1000);
    expect(computeBackoffMs(snap, 3)).toBe(3000);
    expect(computeBackoffMs(snap, 10)).toBe(10_000);
  });

  it("exponential strategy doubles per attempt", () => {
    const snap = { ...base, strategy: "exponential" as const };
    expect(computeBackoffMs(snap, 1)).toBe(1000);
    expect(computeBackoffMs(snap, 2)).toBe(2000);
    expect(computeBackoffMs(snap, 3)).toBe(4000);
    expect(computeBackoffMs(snap, 4)).toBe(8000);
  });

  it("caps every strategy at maxDelayMs", () => {
    expect(computeBackoffMs({ ...base, strategy: "exponential" }, 30)).toBe(60_000);
    expect(
      computeBackoffMs({ ...base, strategy: "linear", maxDelayMs: 2500 }, 10),
    ).toBe(2500);
  });

  it("jitter keeps the delay within ±15% of the deterministic value", () => {
    const snap = { ...base, strategy: "fixed" as const, jitter: true };
    expect(computeBackoffMs(snap, 1, () => 0)).toBe(850); // 0.85x
    expect(computeBackoffMs(snap, 1, () => 1)).toBe(1150); // 1.15x
    expect(computeBackoffMs(snap, 1, () => 0.5)).toBe(1000);
    for (let i = 0; i < 50; i++) {
      const d = computeBackoffMs(snap, 1);
      expect(d).toBeGreaterThanOrEqual(850);
      expect(d).toBeLessThanOrEqual(1150);
    }
  });

  it("treats attempt < 1 as attempt 1", () => {
    expect(computeBackoffMs({ ...base, strategy: "linear" }, 0)).toBe(1000);
  });
});
