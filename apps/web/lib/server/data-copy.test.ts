/**
 * When the page may promise that the last try of a copy will have ended. The
 * minutes a person is told are counted from this, so it may never fall short
 * of the schedule: each try left, the one under way included, is allowed a
 * minute and a half past its due moment.
 */

import { describe, expect, it } from "vitest";

import { triesEndBy } from "./data-copy";

const T = Date.parse("2026-10-26T09:00:00.000Z");
const MINUTE = 60_000;

const request = (
  attempts: number,
  nextAttemptAt: number,
  leaseExpiresAt: number | null = null,
) => ({
  attempts,
  nextAttemptAt: new Date(nextAttemptAt),
  leaseExpiresAt: leaseExpiresAt === null ? null : new Date(leaseExpiresAt),
});

describe("the end of a copy's tries", () => {
  it.each([
    ["while the first try is under way", request(1, T, T + 2 * MINUTE), T + 60.5 * MINUTE],
    ["after the first try was refused", request(1, T + MINUTE), T + 57 * MINUTE],
    ["while the fourth try is under way", request(4, T, T + 2 * MINUTE), T + 35 * MINUTE],
    ["while the fifth and last try waits", request(4, T + 30 * MINUTE), T + 31.5 * MINUTE],
  ])("is counted from the try under way or the next one %s", (_when, standing, end) => {
    expect(triesEndBy(standing, new Date(T)).getTime()).toBe(end);
  });

  it("counts a lease that ran out, its process gone, as no try under way and the next one due now", () => {
    expect(triesEndBy(request(4, T - MINUTE, T - 1), new Date(T)).getTime()).toBe(T + 1.5 * MINUTE);
  });
});
