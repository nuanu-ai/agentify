import { afterEach, describe, expect, it, vi } from "vitest";
import { startLostScanSweeper } from "./lost-scan-sweeper.js";

describe("lost scan sweeper", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps closing lost scans after a sweep fails, and reports both", async () => {
    vi.useFakeTimers();
    let sweeps = 0;
    const errors: unknown[] = [];
    const finished: string[][] = [];
    const stop = startLostScanSweeper({
      finishLostScans: async () => {
        sweeps += 1;
        if (sweeps === 1) throw new Error("connection terminated");
        return ["018f3f56-2ec8-7b16-8f66-5b8f93f3251f"];
      },
      onFinished: (scanIds) => finished.push(scanIds),
      onError: (error) => errors.push(error),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toHaveLength(1);
    expect(finished).toEqual([["018f3f56-2ec8-7b16-8f66-5b8f93f3251f"]]);

    stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(finished).toHaveLength(1);
  });
});
