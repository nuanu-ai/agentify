/**
 * One merchant's places for one kind of work, read through what callers get:
 * a place at once, a place after waiting, or none.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MerchantGate } from "./merchant-gate.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Whether a promise has settled, without waiting for it. */
async function landed(pending: Promise<unknown>): Promise<boolean> {
  let done = false;
  void pending.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

describe("a merchant's gate", () => {
  it("lets a waiter in when a place frees, and turns one away whose time ran out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = new MerchantGate({ atOnce: 1, waitingAtMost: 4 });
    const first = await gate.enter("mch_a", 1_000);
    if (first === null) throw new Error("the first caller found no place");
    const second = gate.enter("mch_a", 1_000);
    const third = gate.enter("mch_a", 500);
    expect(await landed(second)).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(await third).toBeNull();
    first();
    expect(await second).toEqual(expect.any(Function));
  });

  it("turns a newcomer away at once when the line is as long as it may be", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = new MerchantGate({ atOnce: 1, waitingAtMost: 2 });
    await gate.enter("mch_a", 1_000);
    const waiting = [gate.enter("mch_a", 1_000), gate.enter("mch_a", 1_000)];

    const turnedAway = gate.enter("mch_a", 1_000);

    expect(await landed(turnedAway)).toBe(true);
    expect(await turnedAway).toBeNull();
    for (const waiter of waiting) expect(await landed(waiter)).toBe(false);
  });

  it("keeps each merchant's line to itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = new MerchantGate({ atOnce: 1, waitingAtMost: 1 });
    await gate.enter("mch_a", 1_000);
    void gate.enter("mch_a", 1_000);

    expect(await gate.enter("mch_b", 0)).toEqual(expect.any(Function));
  });

  it("counts a merchant's second until it ends, after every place is given back", async () => {
    // A merchant with nothing under way is forgotten only once its second is
    // over, or giving places back would reset the count.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = new MerchantGate({ atOnce: 2, perSecond: 2, waitingAtMost: 4 });
    for (let one = 0; one < 2; one += 1) (await gate.enter("mch_a", 0))?.();

    expect(await gate.enter("mch_a", 0)).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await gate.enter("mch_a", 0)).toEqual(expect.any(Function));
  });

  it("lets one payer hold one place and wait for one more, and turns its third away at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = new MerchantGate({ atOnce: 4, waitingAtMost: 8 });
    const held = await gate.enter("mch_a", 1_000, "0xpayer");
    if (held === null) throw new Error("the payer found no place");
    const second = gate.enter("mch_a", 1_000, "0xpayer");
    const third = gate.enter("mch_a", 1_000, "0xpayer");

    expect(await landed(second)).toBe(false);
    expect(await third).toBeNull();
    held();
    expect(await second).toEqual(expect.any(Function));
  });

  it("lets other payers in past a payer that waits for its own place to free", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = new MerchantGate({ atOnce: 4, waitingAtMost: 8 });
    await gate.enter("mch_a", 1_000, "0xpayer");
    void gate.enter("mch_a", 1_000, "0xpayer");

    expect(await gate.enter("mch_a", 0, "0xanother")).toEqual(expect.any(Function));
  });
});
