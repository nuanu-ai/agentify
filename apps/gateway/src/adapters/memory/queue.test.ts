import type { WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../../ports/queue.js";
import { MemoryQueue } from "./queue.js";

const envelope = (id: string): WorkerEnvelope => ({
  kind: "order_event",
  id,
  sent_at: "2026-08-26T00:00:00.000Z",
  payload: {
    type: "order.unpaid_after_confirmation",
    order_id: "ord_1",
    at: "2026-08-26T00:00:00.000Z",
  },
});

/** Whose stream: there is one per merchant, so every call names one. */
const A = "mch_a";
const B = "mch_b";

const started = async (fire: (reminder: Reminder) => Promise<void> = async () => undefined) => {
  const queue = new MemoryQueue();
  queue.onReminder(fire);
  await queue.start();
  return queue;
};

describe("MemoryQueue delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wakes a parked poll the moment something is published", async () => {
    // A parked poll keeps the price question of a synchronous purchase, which
    // an agent is waiting on, bounded by the network rather than by a poll
    // interval.
    const queue = await started();
    const parked = queue.draw(A, 10, 25_000);

    await vi.advanceTimersByTimeAsync(5);
    await queue.publish(A, envelope("env_1"));

    const drawn = await parked;
    expect(drawn.map((d) => d.envelope.id)).toStrictEqual(["env_1"]);
  });

  it("answers a quiet window with an empty batch rather than a failure", async () => {
    // A worker that read an empty batch as a failure would tear down and
    // rebuild its subscription every time nothing happened.
    const queue = await started();
    const parked = queue.draw(A, 10, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await parked).toStrictEqual([]);
  });

  it("comes straight back with whatever is queued when no wait is asked for", async () => {
    // A worker shutting down asks for a drain, and a drain that parked for
    // twenty-five seconds would hold the shutdown open for twenty-five seconds.
    const queue = await started();
    await queue.publish(A, envelope("env_1"));

    expect((await queue.draw(A, 10, 0)).map((d) => d.envelope.id)).toStrictEqual(["env_1"]);
    expect(await queue.draw(A, 10, 0)).toStrictEqual([]);
  });

  it("hands out no more than the batch that was asked for, and keeps the rest", async () => {
    const queue = await started();
    await queue.publish(A, envelope("env_1"));
    await queue.publish(A, envelope("env_2"));
    await queue.publish(A, envelope("env_3"));

    expect((await queue.draw(A, 2, 0)).map((d) => d.envelope.id)).toStrictEqual(["env_1", "env_2"]);
    expect((await queue.draw(A, 2, 0)).map((d) => d.envelope.id)).toStrictEqual(["env_3"]);
  });

  it("keeps a delayed envelope back until its time", async () => {
    // The order machine's redelivery carries a wait, and a queue that ignored
    // it would hammer a merchant who is already failing.
    const queue = await started();
    await queue.publish(A, envelope("env_1"), 500);

    await vi.advanceTimersByTimeAsync(499);
    expect(await queue.draw(A, 10, 0)).toStrictEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect((await queue.draw(A, 10, 0)).map((d) => d.envelope.id)).toStrictEqual(["env_1"]);
  });

  it("does not put a drawn envelope back on the stream by itself", async () => {
    // Repeating an unanswered delivery is the order machine's call: only it
    // knows how many attempts are left and whether another could still land
    // inside the deadline.
    const queue = await started();
    await queue.publish(A, envelope("env_1"));

    expect(await queue.draw(A, 10, 0)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(await queue.draw(A, 10, 0)).toStrictEqual([]);
  });

  it("takes a second answer to an answered delivery without complaining", async () => {
    // The portal promises the merchant that repeating a call is safe, and a
    // repeat carries the handle of a delivery that is already finished.
    const queue = await started();
    await queue.publish(A, envelope("env_1"));
    const [drawn] = await queue.draw(A, 10, 0);

    if (drawn === undefined) throw new Error("nothing was drawn");
    await queue.finish(A, drawn.handle);
    await expect(queue.finish(A, drawn.handle)).resolves.toBeUndefined();
    await expect(queue.finish(A, "a handle from nowhere")).resolves.toBeUndefined();
  });

  it("gives two deliveries of one envelope two handles", async () => {
    // One envelope can reach a stream twice: the poll puts back one whose
    // hand-over it could not record. A shared handle would let the answer to
    // one arrival finish the other, which nobody has answered.
    const queue = await started();
    await queue.publish(A, envelope("env_1"));
    await queue.publish(A, envelope("env_1"));

    const [first, second] = await queue.draw(A, 10, 0);
    expect(first?.handle).not.toBe(second?.handle);
  });

  it("never hands one merchant's envelope to another merchant's worker", async () => {
    // Not one shared stream filtered on the way out: a filter would have to
    // draw a stranger's envelope to look at it, hiding it from its own
    // merchant. So B never sees A's envelope, and A still finds it afterwards.
    const queue = await started();
    await queue.publish(A, envelope("env_1"));

    expect(await queue.draw(B, 10, 0)).toStrictEqual([]);
    expect((await queue.draw(A, 10, 0)).map((d) => d.envelope.id)).toStrictEqual(["env_1"]);
  });

  it("does not send another merchant's parked worker back to an empty stream", async () => {
    // Waking every parked poll on every publish would send each back empty,
    // over and over, on a busy gateway. B's poll also comes back empty when its
    // wait runs out, so the test tells the two apart by timing.
    const queue = await started();
    let back = false;
    const parkedOnB = queue.draw(B, 10, 1_000).finally(() => {
      back = true;
    });

    await vi.advanceTimersByTimeAsync(5);
    await queue.publish(A, envelope("env_1"));
    await vi.advanceTimersByTimeAsync(5);
    expect(back).toBe(false);

    await vi.advanceTimersByTimeAsync(990);
    expect(await parkedOnB).toStrictEqual([]);
  });
});

describe("MemoryQueue letting go of a parcel's address", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** An order envelope: what carries the whole address once a parcel is paid. */
  const handOver = (id: string, orderId: string): WorkerEnvelope => ({
    kind: "order",
    id,
    sent_at: "2026-08-26T00:00:00.000Z",
    payload: {
      id: orderId,
      merchant_item_id: "beans-1kg",
      params: {},
      price: {
        amount: "21.00",
        currency: "USD",
        at: "2026-08-26T00:00:00.000Z",
        as_of: "2026-08-26T00:00:00.000Z",
      },
      test: true,
    },
  });

  /** A price question: what carries the place the parcel goes. */
  const question = (id: string, priceId: string): WorkerEnvelope => ({
    kind: "quote_request",
    id,
    sent_at: "2026-08-26T00:00:00.000Z",
    payload: {
      merchant_item_id: "beans-1kg",
      price_id: priceId,
      purpose: "purchase",
      expires_at: "2026-08-26T00:10:00.000Z",
    },
  });

  it("forgets an order's hand-overs and its price question wherever they wait, and nothing else", async () => {
    // Once the merchant has the address, no envelope carrying any of it may
    // still reach a worker, a hand-over waiting out a delay included. Events
    // about the order carry no address and stay, as does everybody else's work.
    const queue = await started();
    await queue.publish(A, question("env_q1", "prc_1"));
    await queue.publish(A, handOver("env_o1", "ord_1"));
    await queue.publish(A, handOver("env_o1_later", "ord_1"), 1_000);
    await queue.publish(A, envelope("env_event"));
    await queue.publish(A, question("env_q2", "prc_2"));
    await queue.publish(A, handOver("env_o2", "ord_2"));

    queue.forget(A, "ord_1", "prc_1");
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await queue.draw(A, 10, 0)).map((d) => d.envelope.id)).toStrictEqual([
      "env_event",
      "env_q2",
      "env_o2",
    ]);
    expect(await queue.holdsOrder(A, "ord_1")).toBe(false);
  });

  it("forgets only on the stream it is told to", async () => {
    // A stream belongs to one merchant, and so does letting go of what is on
    // it: another merchant's order of the same name is somebody else's sale.
    const queue = await started();
    await queue.publish(B, handOver("env_b", "ord_1"));

    queue.forget(A, "ord_1", null);

    expect((await queue.draw(B, 10, 0)).map((d) => d.envelope.id)).toStrictEqual(["env_b"]);
  });
});

describe("MemoryQueue reminders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a reminder once, when its time comes", async () => {
    const fired: Reminder[] = [];
    const queue = await started(async (reminder) => {
      fired.push(reminder);
    });

    const reminder: Reminder = {
      kind: "deadline",
      orderId: "ord_1",
      deadline: "quote_response",
      at: 5_000,
    };
    await queue.remind(reminder, 1_000);

    await vi.advanceTimersByTimeAsync(999);
    expect(fired).toStrictEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toStrictEqual([reminder]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toHaveLength(1);
  });

  it("will not start with nowhere to put reminders", async () => {
    // A gateway whose queue swallowed every deadline would look healthy and
    // would never close an overdue order.
    const queue = new MemoryQueue();
    await expect(queue.start()).rejects.toThrow(/nowhere to put reminders/);
  });

  it("refuses to be re-pointed once it is running", async () => {
    const queue = await started();
    expect(() => queue.onReminder(async () => undefined)).toThrow(/before the queue is started/);
  });

  it("drops the reminders it has not fired when it stops", async () => {
    const fired: Reminder[] = [];
    const queue = await started(async (reminder) => {
      fired.push(reminder);
    });

    await queue.remind({ kind: "delivery_unanswered", orderId: "ord_1", handOver: "dlv_1" }, 1_000);
    await queue.stop();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fired).toStrictEqual([]);
  });

  it("lets go of a parked poll when it stops", async () => {
    const queue = await started();
    const parked = queue.draw(A, 10, 25_000);

    await queue.stop();

    expect(await parked).toStrictEqual([]);
  });
});

describe("MemoryQueue holding an order", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const orderEnvelope = (id: string, orderId: string): WorkerEnvelope => ({
    kind: "order",
    id,
    sent_at: "2026-08-26T00:00:00.000Z",
    payload: {
      id: orderId,
      merchant_item_id: "sku-1",
      params: {},
      price: {
        amount: "12.00",
        currency: "USD",
        at: "2026-08-26T00:00:00.000Z",
        as_of: "2026-08-26T00:00:00.000Z",
      },
      test: true,
    },
  });

  it("counts an envelope waiting out a delay, which is one that will be handed over", async () => {
    // The sweep resends a paid order only when the stream holds nothing for
    // it, since every hand-over counts against the attempt cap. The poll puts
    // an envelope back with a wait when it meets a charge in flight; missed
    // here, the sweep would spend one of the order's attempts on a hand-over
    // already on its way.
    const queue = await started();
    await queue.publish(A, orderEnvelope("env_1", "ord_waiting"), 60_000);

    expect(await queue.holdsOrder(A, "ord_waiting")).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await queue.holdsOrder(A, "ord_waiting")).toBe(true);
  });

  it("stops counting one that a worker has drawn, and never counts an event", async () => {
    // A drawn envelope is in nobody's stream, which is why the sweep also waits
    // before resending. Nothing ever re-sends an event, so an event about an
    // order does not count as holding it.
    const queue = await started();
    await queue.publish(A, orderEnvelope("env_1", "ord_1"));
    expect(await queue.holdsOrder(A, "ord_1")).toBe(true);

    await queue.draw(A, 10, 0);
    expect(await queue.holdsOrder(A, "ord_1")).toBe(false);

    // `envelope` above is an order event carrying this very order.
    await queue.publish(A, envelope("env_2"));
    expect(await queue.holdsOrder(A, "ord_1")).toBe(false);
  });

  it("answers about one merchant's stream and not another's", async () => {
    // Answered across streams, the sweep would leave an order alone because
    // somebody else's stream had something on it.
    const queue = await started();
    await queue.publish(A, orderEnvelope("env_1", "ord_1"));

    expect(await queue.holdsOrder(A, "ord_1")).toBe(true);
    expect(await queue.holdsOrder(B, "ord_1")).toBe(false);
  });
});
