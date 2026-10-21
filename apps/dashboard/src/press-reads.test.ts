/**
 * Which read of a page is taken for a press's own, so a view is never counted
 * for it, and how long a press is remembered for that.
 */

import { describe, expect, it } from "vitest";
import { pressReads } from "./press-reads.js";

describe("which read is a press's own", () => {
  it("takes a read of the pressed page for the press's own for ten seconds, and a view after that", () => {
    let clock = 1_000_000;
    const reads = pressReads(() => clock);

    reads.pressed("early", "/cards");
    reads.pressed("late", "/cards");
    clock += 10_000;
    const inTime = reads.isPressRead("early", "/cards");
    clock += 1;
    const tooLate = reads.isPressRead("late", "/cards");

    expect([inTime, tooLate]).toStrictEqual([true, false]);
  });

  it("remembers the last thousand presses, and forgets the oldest beyond them", () => {
    const reads = pressReads(() => 0);

    for (let press = 0; press <= 1_000; press += 1) reads.pressed(`press-${press}`, "/cards");

    expect(reads.isPressRead("press-0", "/cards")).toBe(false);
    expect(reads.isPressRead("press-1", "/cards")).toBe(true);
    expect(reads.isPressRead("press-1000", "/cards")).toBe(true);
  });
});
