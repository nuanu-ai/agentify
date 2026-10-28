import { describe, expect, it } from "vitest";
import { must, newOrder, T0, TEST_POLICY, walk } from "./fixtures.js";
import { nextRedelivery } from "./redelivery.js";

const policy = TEST_POLICY.redelivery;

/**
 * A handler exception, a dead process and a broken connection are one thing:
 * the answer never came back. Such an order is delivered again rather than
 * closed, and the repeating stops before the mode's deadline instead of running
 * past it.
 */
describe("deciding whether to deliver an order again", () => {
  it("backs off further with every attempt", () => {
    const first = nextRedelivery({ attempts: 1, now: 0, deadlineAt: null, policy });
    const second = nextRedelivery({ attempts: 2, now: 0, deadlineAt: null, policy });
    const third = nextRedelivery({ attempts: 3, now: 0, deadlineAt: null, policy });

    expect(first).toStrictEqual({ retry: true, attempt: 2, delayMs: 1_000 });
    expect(second).toStrictEqual({ retry: true, attempt: 3, delayMs: 2_000 });
    expect(third).toStrictEqual({ retry: true, attempt: 4, delayMs: 4_000 });
  });

  it("never backs off further than the policy's ceiling", () => {
    // Doubling from a thousand passes a minute at the eighth attempt: the
    // seventh waits thirty-two seconds, the eighth would wait sixty-four. The
    // buyer sits through the wait, so the ceiling is the promise; the growth is
    // pinned on both sides of the attempt that crosses it and once well past.
    const patient = { ...policy, maxAttempts: 100 };
    const madeSoFar = (attempts: number) =>
      nextRedelivery({ attempts, now: 0, deadlineAt: null, policy: patient });

    expect(madeSoFar(6)).toStrictEqual({ retry: true, attempt: 7, delayMs: 32_000 });
    expect(madeSoFar(7)).toStrictEqual({ retry: true, attempt: 8, delayMs: policy.maxDelayMs });
    expect(madeSoFar(20)).toStrictEqual({ retry: true, attempt: 21, delayMs: policy.maxDelayMs });
  });

  it("gives up once the policy's attempts are spent", () => {
    const spent = nextRedelivery({
      attempts: policy.maxAttempts,
      now: 0,
      deadlineAt: null,
      policy,
    });
    const wellPast = nextRedelivery({ attempts: 20, now: 0, deadlineAt: null, policy });

    expect(spent).toStrictEqual({ retry: false, reason: "attempts_exhausted" });
    expect(wellPast).toStrictEqual({ retry: false, reason: "attempts_exhausted" });
  });

  it("gives up when the next attempt would land past the mode's deadline", () => {
    // The worker does not start the handler after the deadline: a delivery
    // that would arrive too late is not attempted at all.
    const decision = nextRedelivery({ attempts: 1, now: 500, deadlineAt: 1_000, policy });

    expect(decision).toStrictEqual({ retry: false, reason: "past_deadline" });
  });

  it("still tries when the next attempt fits inside the deadline", () => {
    const decision = nextRedelivery({ attempts: 1, now: 500, deadlineAt: 5_000, policy });

    expect(decision).toStrictEqual({ retry: true, attempt: 2, delayMs: 1_000 });
  });

  it("does not attempt a delivery that would land exactly on the deadline", () => {
    // The deadline's instant belongs to the expiry: the machine treats an
    // expiry claiming that same instant as due, so a handler started there
    // starts on an order already out of time. One millisecond earlier the
    // attempt is worth making.
    const onTheDot = nextRedelivery({ attempts: 1, now: 0, deadlineAt: 1_000, policy });
    const justInside = nextRedelivery({ attempts: 1, now: 0, deadlineAt: 1_001, policy });

    expect(onTheDot).toStrictEqual({ retry: false, reason: "past_deadline" });
    expect(justInside).toStrictEqual({ retry: true, attempt: 2, delayMs: 1_000 });
  });
});

/**
 * The gateway's own shape: pauses from half a second, doubling, never longer
 * than fifteen minutes, for three hours after the order first reached its
 * merchant.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const THREE_HOURS = {
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 15 * MINUTE,
  windowMs: 3 * HOUR,
};

describe("handing an unanswered order over again for three hours", () => {
  it("hands it over again long after five attempts while the three hours last", () => {
    expect(
      nextRedelivery({
        attempts: 12,
        now: T0 + 2 * HOUR,
        firstHandedOverAt: T0,
        deadlineAt: null,
        policy: THREE_HOURS,
      }),
    ).toStrictEqual({ retry: true, attempt: 13, delayMs: 15 * MINUTE });
  });

  it("stops once the next hand-over would land three hours or more after the first", () => {
    const at = (now: number) =>
      nextRedelivery({
        attempts: 12,
        now,
        firstHandedOverAt: T0,
        deadlineAt: null,
        policy: THREE_HOURS,
      });

    expect(at(T0 + 2 * HOUR + 44 * MINUTE).retry).toBe(true);
    expect(at(T0 + 2 * HOUR + 45 * MINUTE)).toStrictEqual({ retry: false, reason: "past_window" });
  });

  it("measures the three hours from the first hand-over, however many came after it", () => {
    // A day to fulfil, so only the three hours can stop the repeats.
    const policy = {
      deadlines: { ...TEST_POLICY.deadlines, asyncFulfillmentMs: 24 * HOUR },
      redelivery: THREE_HOURS,
    };
    let order = walk(newOrder("async", { policy }), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
    ]);
    // Handed over again and again; the last time a minute before the silence.
    for (const minutes of [30, 60, 120, 170])
      order = must(order, { kind: "order_dispatched", at: T0 + minutes * MINUTE }).order;

    const silence = must(order, { kind: "handler_undelivered", at: T0 + 171 * MINUTE });

    expect(silence.effects.filter((effect) => effect.kind === "redeliver_order")).toStrictEqual([]);
    expect(silence.order.state).toBe("dispatched");
  });
});
