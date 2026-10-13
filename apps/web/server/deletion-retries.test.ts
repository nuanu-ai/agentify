import { afterEach, describe, expect, it, vi } from "vitest";

import { DELETION_RETRY_INTERVAL_MS, startDeletionRetries } from "./deletion-retries";

afterEach(() => {
  vi.useRealTimers();
});

const CONFIGURED = {
  DASHBOARD_IDENTITY_URL: "http://127.0.0.1:1",
  REPORT_IDENTITY_SECRET: "a-report-identity-secret-for-the-test",
};

describe("the retry of pending identity deletions", () => {
  it("asks at once and then every thirty seconds where the dashboard's private route is configured", () => {
    vi.useFakeTimers();
    const retry = vi.fn(async () => 0);

    const retries = startDeletionRetries(CONFIGURED, retry);
    expect(retry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DELETION_RETRY_INTERVAL_MS * 2);
    expect(retry).toHaveBeenCalledTimes(3);

    retries.stop();
    vi.advanceTimersByTime(DELETION_RETRY_INTERVAL_MS);
    expect(retry).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["the route's address", { REPORT_IDENTITY_SECRET: CONFIGURED.REPORT_IDENTITY_SECRET }],
    ["the route's secret", { DASHBOARD_IDENTITY_URL: CONFIGURED.DASHBOARD_IDENTITY_URL }],
  ])("asks nothing where %s is missing", (_missing, environment) => {
    vi.useFakeTimers();
    const retry = vi.fn(async () => 0);

    startDeletionRetries(environment, retry);
    vi.advanceTimersByTime(DELETION_RETRY_INTERVAL_MS * 2);

    expect(retry).not.toHaveBeenCalled();
  });

  it("goes on asking after a round that failed", async () => {
    vi.useFakeTimers();
    const retry = vi.fn(async () => {
      throw new Error("the dashboard did not answer");
    });

    const retries = startDeletionRetries(CONFIGURED, retry);
    await vi.advanceTimersByTimeAsync(DELETION_RETRY_INTERVAL_MS);

    expect(retry).toHaveBeenCalledTimes(2);
    retries.stop();
  });
});
