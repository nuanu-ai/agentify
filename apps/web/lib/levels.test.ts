import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the day a scan is named by", () => {
  it("is its day in UTC, wherever the machine drawing it is", async () => {
    // Fourteen hours east of UTC, late on the 13th there is already the 14th.
    vi.stubEnv("TZ", "Pacific/Kiritimati");
    vi.resetModules();
    const { scanDay } = await import("./levels");

    expect(scanDay("2026-10-13T23:30:00.000Z")).toBe("Oct 13, 2026");
  });

  it("is no day at all for a moment that is no date, rather than a wrong day or a failure", async () => {
    const { scanDay } = await import("./levels");

    expect(scanDay("not a moment")).toBeNull();
  });
});
