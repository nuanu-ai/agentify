import { afterEach, describe, expect, it, vi } from "vitest";

import { DELETION_RETRY_INTERVAL_MS, startDeletionRetries } from "./deletion-retries";

afterEach(() => {
  vi.useRealTimers();
});

/** A round of retries that does `work` and counts how often it was asked. */
const rounds = (work: () => Promise<number>) => {
  let times = 0;
  return {
    retry: () => {
      times += 1;
      return work();
    },
    times: () => times,
  };
};

const CONFIGURED = {
  DASHBOARD_IDENTITY_URL: "http://127.0.0.1:1",
  REPORT_IDENTITY_SECRET: "a-report-identity-secret-for-the-test",
};

describe("the retry of pending identity deletions", () => {
  it("asks at once and then every thirty seconds where the dashboard's private route is configured", () => {
    vi.useFakeTimers();
    const asked = rounds(async () => 0);

    const retries = startDeletionRetries(CONFIGURED, asked.retry);
    expect(asked.times()).toBe(1);
    vi.advanceTimersByTime(DELETION_RETRY_INTERVAL_MS * 2);
    expect(asked.times()).toBe(3);

    retries.stop();
    vi.advanceTimersByTime(DELETION_RETRY_INTERVAL_MS);
    expect(asked.times()).toBe(3);
  });

  it.each([
    ["the route's address", { REPORT_IDENTITY_SECRET: CONFIGURED.REPORT_IDENTITY_SECRET }],
    ["the route's secret", { DASHBOARD_IDENTITY_URL: CONFIGURED.DASHBOARD_IDENTITY_URL }],
  ])("asks nothing where %s is missing", (_missing, environment) => {
    vi.useFakeTimers();
    const asked = rounds(async () => 0);

    startDeletionRetries(environment, asked.retry);
    vi.advanceTimersByTime(DELETION_RETRY_INTERVAL_MS * 2);

    expect(asked.times()).toBe(0);
  });

  it("goes on asking after a round that failed", async () => {
    vi.useFakeTimers();
    const asked = rounds(async () => {
      throw new Error("the dashboard did not answer");
    });

    const retries = startDeletionRetries(CONFIGURED, asked.retry);
    await vi.advanceTimersByTimeAsync(DELETION_RETRY_INTERVAL_MS);

    expect(asked.times()).toBe(2);
    retries.stop();
  });
});
