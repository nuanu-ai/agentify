import { outcomeFor } from "@agentify/core";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../ports/queue.js";
import {
  authorisation,
  drawEverything,
  type Harness,
  harness,
  workUntilStopped,
} from "../testing/harness.js";

/** The buyer, for the one test here that turns on which wallet signed. */
const BUYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/**
 * Each test here is one row of the portal's "time ran out" table: what happens
 * when a deadline runs out, and whose money is where afterwards.
 */

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

const asyncCard: Card = {
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
};

/**
 * Deadlines short enough that an order lives and dies inside one test.
 *
 * SYNC_BUDGET_MS is deliberately far above SYNC_RESPONSE_MS. The budget is a
 * real wait racing the real timer that ends the order, and the two start at
 * slightly different instants, so a narrow gap lets a loaded machine end the
 * agent's wait first and tell it `under_way` about an order about to close.
 */
const brisk = {
  QUOTE_RESPONSE_MS: "20",
  QUOTE_TTL_MS: "60",
  SYNC_RESPONSE_MS: "80",
  SETTLE_RESPONSE_MS: "40",
  SYNC_BUDGET_MS: "2000",
  HANDLER_ANSWER_MS: "1000",
  DEFAULT_ASYNC_FULFILLMENT_MS: "80",
};

let open: Harness | null = null;
const started = async (overrides: Record<string, string> = {}) => {
  open = await harness({ ...brisk, ...overrides });
  return open;
};

afterEach(async () => {
  await open?.stop();
  open = null;
});

const bought = async (harnessed: Harness, card: Card): Promise<string> => {
  const published = await harnessed.gateway.publishCard(harnessed.merchant.id, card);
  if (!published.ok) throw new Error("the card would not publish");
  const offered = await harnessed.gateway.beginPurchase(published.id, {});
  if (offered.step !== "pay") throw new Error("no price was offered");
  return offered.order.order.id;
};

const state = async (harnessed: Harness, orderId: string) =>
  (await harnessed.store.orderById(orderId))?.order;

describe("when the time runs out", () => {
  it("closes a synchronous purchase nobody answered, and charges nothing", async () => {
    // In the synchronous mode the buyer's money never moves until the goods
    // exist.
    const harnessed = await started();
    const orderId = await bought(harnessed, syncCard);

    const settled = await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    expect(settled.step).toBe("settled");
    if (settled.step !== "settled") throw new Error("the purchase did not settle");
    expect(settled.order.order.state).toBe("expired");
    expect(settled.order.order.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "sync_response",
    });
    expect(harnessed.facilitator.settles).toHaveLength(0);
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();
  });

  it("tells the agent its synchronous purchase expired when the timer that closes it is late", async () => {
    // In a deployment the deadline timer comes off a polling queue and can land
    // after the agent's wait has run out; the agent is still owed how the
    // purchase ended. The wait is a full second so that a loaded machine cannot
    // end it before the clock below is moved.
    const harnessed = await started({ SYNC_BUDGET_MS: "1000" });
    const orderId = await bought(harnessed, syncCard);
    // From the payment on, every timer is late: none of them lands inside the
    // agent's wait.
    vi.spyOn(harnessed.queue, "remind").mockResolvedValue(undefined);

    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 200)).envelopes).toHaveLength(1);
    harnessed.advance(Number(brisk.SYNC_RESPONSE_MS));
    const settled = await buying;

    expect(settled.step).toBe("settled");
    expect((await state(harnessed, orderId))?.state).toBe("expired");
    expect(harnessed.facilitator.settles).toHaveLength(0);
  });

  it("does not tell a merchant a closed order still stands", async () => {
    // Goods are checked against the card before the order's state is consulted.
    // Told "still stands" and "retryable" on an expired order, a merchant would
    // fix his handler for a sale he has already lost.
    const harnessed = await started();
    const orderId = await bought(harnessed, syncCard);

    const settled = await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    if (settled.step !== "settled") throw new Error("the purchase did not settle");
    expect(settled.order.order.state).toBe("expired");

    // The card declares an access code; this sends a serial. The goods are wrong
    // and the order is over, and it is the second that decides what he can do.
    const refused = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      serial: "89310410106543789301",
    });

    if (refused?.ok !== false) throw new Error("goods were taken against a closed order");
    expect(refused.error.code).toBe("delivery_does_not_match_card");
    expect(refused.error.message).toContain("expired");
    expect(refused.error.message).not.toContain("still stands where it did");
    expect(refused.error.retryable).toBe(false);
    expect(refused.error.message).toContain("serial");

    expect((await harnessed.store.orderById(orderId))?.delivery).toBeNull();
  });

  it("still says an open order stands where it did", async () => {
    // The negative control: on an order he can still finish, that clause is
    // what tells the merchant his goods are still wanted.
    const harnessed = await started({ DEFAULT_ASYNC_FULFILLMENT_MS: "5000" });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const refused = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      serial: "89310410106543789301",
    });

    if (refused?.ok !== false) throw new Error("goods the card never declared were taken");
    expect(refused.error.message).toContain("still stands where it did");
    expect(refused.error.retryable).toBe(true);
  });

  it("marks an asynchronous order for a refund, because the money is already gone", async () => {
    // Unlike the synchronous case the charge went through at the purchase, so an
    // ending that said "nothing happened" would leave the buyer out of pocket.
    const harnessed = await started();
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      {
        timeout: 2_000,
        interval: 5,
      },
    );

    const owing = await state(harnessed, orderId);
    expect(owing?.payment).toBe("settled");
    expect(owing?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "async_fulfillment",
    });

    const told = await drawEverything(harnessed);
    const events = told.flatMap((e) => (e.kind === "order_event" ? [e.payload] : []));
    expect(events.map((e) => e.type)).toContain("order.refund_due");
  });

  it("keeps the first of two late answers in the drawer, and the buyer collects that one", async () => {
    // A late answer after a synchronous timeout is held for a repeat purchase to
    // collect, and the first one held is kept. A handler that issues a fresh code
    // per run therefore has its later code discarded; if the buyer should get the
    // latest instead, this is the test that changes.
    const harnessed = await started();
    const orderId = await bought(harnessed, syncCard);

    const paid = authorisation(harnessed, BUYER, "0x01");
    const settled = await harnessed.gateway.payPurchase(orderId, paid.payment, paid.fingerprint);
    expect(settled.step).toBe("settled");
    expect((await state(harnessed, orderId))?.state).toBe("expired");

    const first = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "CODE-ONE" },
    });
    const second = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "CODE-TWO" },
    });

    expect(first).toStrictEqual({ ok: true, result: "purchase_already_closed" });
    expect(second).toStrictEqual({ ok: true, result: "purchase_already_closed" });
    expect((await state(harnessed, orderId))?.heldFulfillment).toBe(true);
    expect((await harnessed.store.orderById(orderId))?.delivery).toStrictEqual({
      access_code: "CODE-ONE",
    });

    // The repeat is a fresh authorisation from the same wallet, which is how the
    // order's owner is recognised.
    const repeat = authorisation(harnessed, BUYER, "0x02");
    const collected = await harnessed.gateway.payPurchase(
      orderId,
      repeat.payment,
      repeat.fingerprint,
    );
    expect(collected.step).toBe("settled");
    if (collected.step !== "settled") throw new Error("the repeat did not settle");
    expect(collected.delivery).toStrictEqual({ access_code: "CODE-ONE" });
    // Held goods become the buyer's only once the repeat's payment goes through.
    expect((await state(harnessed, orderId))?.state).toBe("delivered");
  });

  it("brings the money back when a handler never sends what the card declares", async () => {
    // A delivery that does not match the card is refused and the order left open
    // for a fix. That is only safe if the deadline still ends an order nobody
    // fixes; otherwise the buyer's money is parked forever.
    const harnessed = await started();
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const refused = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      // The card declares an activation code; this handler sends a serial.
      serial: "89310410106543789301",
    });
    if (refused?.ok !== false) throw new Error("goods the card never declared were taken");
    expect(refused.error.code).toBe("delivery_does_not_match_card");

    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      { timeout: 2_000, interval: 5 },
    );

    const owing = await state(harnessed, orderId);
    expect(owing?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "async_fulfillment",
    });
    expect((await harnessed.store.orderById(orderId))?.delivery).toBeNull();
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();
  });

  it("lets a price the agent sat on stop being a price", async () => {
    // Nothing was charged, so this ending is free; an agent that still wants the
    // item asks for a fresh price.
    const harnessed = await started();
    const orderId = await bought(harnessed, syncCard);

    await vi.waitFor(async () => expect((await state(harnessed, orderId))?.state).toBe("expired"), {
      timeout: 2_000,
      interval: 5,
    });

    expect((await state(harnessed, orderId))?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "quote_expiry",
    });
    expect(harnessed.facilitator.verifies).toHaveLength(0);
  });
});

describe("the wait for the charge", () => {
  it("is longer where the money moves before the goods, and a charge inside it counts", async () => {
    // The answer comes at 200ms: past the synchronous wait of 40ms, inside this one.
    const harnessed = await started({ SETTLE_BEFORE_GOODS_MS: "1000" });
    const orderId = await bought(harnessed, asyncCard);
    const release = harnessed.facilitator.holdSettle();

    const paying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await paying;

    const order = await state(harnessed, orderId);
    expect(order?.payment).toBe("settled");
    expect(order?.closure).toBeNull();
  });

  it("stays short where the goods came first, so the agent hears inside the synchronous ceiling", async () => {
    // The negative control. The wait before goods keeps its fifteen-second
    // default, so a synchronous order put on it would still be settling when
    // the agent's ceiling of 2000ms runs out, and the agent would hear
    // `under_way` instead of the silence.
    const harnessed = await started();
    const orderId = await bought(harnessed, syncCard);
    const release = harnessed.facilitator.holdSettle();
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });

    const answered = await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    expect(answered.step).toBe("settled");
    if (answered.step !== "settled") throw new Error("the agent was not answered");
    expect(answered.order.order.payment).toBe("outcome_unknown");

    // The answer the gateway stopped waiting for still counts once it comes.
    release();
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.payment).toBe("settled"),
      { timeout: 2_000, interval: 5 },
    );
    expect((await state(harnessed, orderId))?.state).toBe("delivered");
    await worker.stop();
  });
});

describe("a synchronous purchase on the waits this gateway ships", () => {
  // The portal gives the handler ten seconds, the charge ten more, and the
  // agent twenty in all. Those are seconds of real time, so the timers are
  // faked and moved together with the harness's clock.
  const STEP_MS = 100;

  /**
   * Moves the clock and the timers together, so each reminder lands within a
   * step of its instant. Work already under way, such as an answer just sent,
   * finishes before the clock moves, or it would read a later instant than the
   * one it was sent at.
   */
  const pass = async (harnessed: Harness, ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= STEP_MS) {
      const step = Math.min(STEP_MS, left);
      await vi.advanceTimersByTimeAsync(0);
      harnessed.advance(step);
      await vi.advanceTimersByTimeAsync(step);
    }
  };

  /**
   * A paid synchronous order in the merchant's hands, with the agent's call
   * still waiting on it, and the instant that call came back once it has.
   */
  const inTheHandlersHands = async () => {
    open = await harness();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harnessed = open;
    const orderId = await bought(harnessed, syncCard);
    const checkedOutAt = harnessed.now();
    let answeredAt: number | null = null;
    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT").then((answer) => {
      answeredAt = harnessed.now();
      return answer;
    });
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 200)).envelopes).toHaveLength(1);
    const deliver = () =>
      harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
        delivered: { access_code: "SESAME" },
      });
    return { harnessed, orderId, buying, deliver, checkedOutAt, answeredAt: () => answeredAt };
  };

  /** What the agent's purchase call came back with, as the status word it is sent. */
  const agentHears = async (buying: ReturnType<Harness["gateway"]["payPurchase"]>) => {
    const answered = await buying;
    if (answered.step !== "settled") throw new Error(`the agent was told ${answered.step}`);
    return { status: outcomeFor(answered.order.order), answered };
  };

  afterEach(async () => {
    await open?.stop();
    open = null;
    vi.useRealTimers();
  });

  it("takes goods a handler sends in its tenth second, and charges for them", async () => {
    const { harnessed, buying, deliver } = await inTheHandlersHands();

    await pass(harnessed, 9_900);
    expect(await deliver()).toStrictEqual({ ok: true, result: "delivered" });

    const { status, answered } = await agentHears(buying);
    expect(status).toBe("delivered");
    expect(answered.delivery).toStrictEqual({ access_code: "SESAME" });
    expect(answered.order.settlement).not.toBeNull();
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("closes the purchase at ten seconds and charges nothing for goods sent after", async () => {
    // The negative control: the handler's deadline is still a deadline.
    const { harnessed, orderId, buying, deliver } = await inTheHandlersHands();

    await pass(harnessed, 10_000);
    expect(await deliver()).toStrictEqual({ ok: true, result: "purchase_already_closed" });

    const { status } = await agentHears(buying);
    expect(status).toBe("expired");
    expect((await state(harnessed, orderId))?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "sync_response",
    });
    expect(harnessed.facilitator.settles).toHaveLength(0);
  });

  it("counts a charge whose answer comes in its tenth second, and hands the agent its goods", async () => {
    // The payment layer answers once the transfer is in a block, which on Base
    // comes every two seconds, so an answer past two seconds is ordinary.
    const { harnessed, buying, deliver, answeredAt } = await inTheHandlersHands();
    const release = harnessed.facilitator.holdSettle();
    const delivering = deliver();

    await pass(harnessed, 9_900);
    expect(answeredAt(), "the agent was answered before the charge was").toBeNull();
    release();
    await delivering;

    const { status, answered } = await agentHears(buying);
    expect(status).toBe("delivered");
    expect(answered.delivery).toStrictEqual({ access_code: "SESAME" });
    expect(answered.order.settlement).not.toBeNull();
  });

  it("declares a charge silent at ten seconds, and tells the agent so then", async () => {
    // The negative control: past its wait a charge is a silence, and the agent
    // hears that rather than waiting on.
    const { harnessed, buying, deliver, checkedOutAt, answeredAt } = await inTheHandlersHands();
    const release = harnessed.facilitator.holdSettle();
    const delivering = deliver();

    await pass(harnessed, 9_999);
    expect(answeredAt(), "the charge was given up on early").toBeNull();
    await pass(harnessed, 1);

    const { status } = await agentHears(buying);
    expect(status).toBe("payment_unresolved");
    expect(answeredAt()).toBe(checkedOutAt + 10_000);
    release();
    await delivering;
  });

  it("answers the agent within twenty seconds when the handler and the charge each take all of theirs", async () => {
    const { harnessed, buying, deliver, checkedOutAt, answeredAt } = await inTheHandlersHands();
    const release = harnessed.facilitator.holdSettle();

    await pass(harnessed, 9_900);
    const delivering = deliver();
    await pass(harnessed, 9_999);
    expect(
      answeredAt(),
      "the agent stopped waiting while the charge could still answer",
    ).toBeNull();
    await pass(harnessed, 101);

    const { status } = await agentHears(buying);
    expect(status).toBe("payment_unresolved");
    expect(answeredAt()).toBeLessThanOrEqual(checkedOutAt + 20_000);
    release();
    await delivering;
  });
});

describe("a card that names no delivery deadline", () => {
  it("holds its merchant to ours, and shows the agent that time on the card", async () => {
    // With no deadline on the card the gateway's default applies and runs out
    // into a refund as a merchant's own would. The card shows that default in
    // whole seconds, rounded up, so an agent that waits as long as the card
    // says never gives up on an order still allowed to arrive.
    const harnessed = await started();
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, asyncCard);
    if (!published.ok) throw new Error("the card would not publish");
    expect(asyncCard.fulfill_deadline_seconds).toBeUndefined();

    const shown = (await harnessed.gateway.catalog()).items[0];
    if (shown === undefined) throw new Error("the card did not reach the catalog");
    expect(shown.fulfillment).toBe("async");
    const heldMs = harnessed.runtime.config.deadlines.defaultAsyncFulfillmentMs;
    const shownMs =
      ("fulfill_deadline_seconds" in shown ? (shown.fulfill_deadline_seconds ?? 0) : 0) * 1_000;
    expect(shownMs).toBeGreaterThanOrEqual(heldMs);
    expect(shownMs - heldMs).toBeLessThan(1_000);

    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      {
        timeout: 2_000,
        interval: 5,
      },
    );
    expect((await state(harnessed, orderId))?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "async_fulfillment",
    });
  });
});

describe("when a delivery goes unanswered", () => {
  it("sends the order again, after the wait the machine asked for", async () => {
    // A thrown handler, a dead process and a broken connection all look like
    // silence, and silence is answered with another delivery, not a refusal.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      REDELIVERY_BASE_DELAY_MS: "10",
      DEFAULT_ASYNC_FULFILLMENT_MS: "3000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    // A worker that draws its stream and never answers anything.
    const silent = workUntilStopped(harnessed, {});
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.dispatch.attempts).toBeGreaterThan(1),
      { timeout: 2_000, interval: 5 },
    );
    await silent.stop();

    expect((await state(harnessed, orderId))?.state).toBe("dispatched");
  });

  it("wraps each repeat in a new message, so only the order's identifier holds still", async () => {
    // A redelivery comes in a new envelope with a new identifier. A handler that
    // deduplicated on the envelope would make the goods twice; the order's
    // identifier is the one that holds still.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      REDELIVERY_BASE_DELAY_MS: "10",
      DEFAULT_ASYNC_FULFILLMENT_MS: "3000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    // A worker that answers nothing and records every envelope it is handed.
    const seen: { readonly message: string; readonly order: string }[] = [];
    let running = true;
    const drawing = (async () => {
      while (running) {
        const { envelopes } = await harnessed.gateway.poll(harnessed.merchant.id, 20);
        for (const envelope of envelopes) {
          if (envelope.kind === "order") {
            seen.push({ message: envelope.id, order: envelope.payload.id });
          }
        }
      }
    })();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1), { timeout: 2_000, interval: 5 });
    running = false;
    await drawing;

    expect(new Set(seen.map((each) => each.order))).toStrictEqual(new Set([orderId]));
    expect(new Set(seen.map((each) => each.message)).size).toBe(seen.length);
  });

  it("stops repeating once the attempts are spent, and leaves the debt to the deadline", async () => {
    // Running out of attempts is not running out of time: the merchant may
    // still deliver until the deadline, and the debt comes from the deadline
    // passing. The money moved at the purchase, so what is left is a debt
    // rather than a free ending.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      REDELIVERY_BASE_DELAY_MS: "5",
      REDELIVERY_MAX_ATTEMPTS: "2",
      DEFAULT_ASYNC_FULFILLMENT_MS: "400",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const silent = workUntilStopped(harnessed, {});
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.dispatch.attempts).toBe(2),
      { timeout: 2_000, interval: 5 },
    );
    expect((await state(harnessed, orderId))?.state).toBe("dispatched");
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      { timeout: 2_000, interval: 5 },
    );
    await silent.stop();

    const owing = await state(harnessed, orderId);
    expect(owing?.dispatch.attempts).toBe(2);
    expect(owing?.payment).toBe("settled");
    expect(owing?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "async_fulfillment",
    });
  });

  it("does not send an order again to a merchant who answered the delivery he was given", async () => {
    // The silence reminder left against the delivery he accepted must not fire
    // behind him, or he is handed the same order every window until his
    // deadline.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      // Short, so that a wrong redelivery would show well before the deadline.
      REDELIVERY_BASE_DELAY_MS: "5",
      // The deadline this test waits for, far enough out that the reminder has
      // fired by then.
      DEFAULT_ASYNC_FULFILLMENT_MS: "150",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const taking = workUntilStopped(harnessed, {
      onOrder: () => ({ accepted: {} }),
    });

    // Wait for the deadline, not for wall time: a sleep would pass on a loaded
    // machine where the reminder had not run yet. The deadline is a later
    // reminder on the same queue, so reaching it means the earlier one has fired.
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      { timeout: 5_000, interval: 5 },
    );
    await taking.stop();

    // Every hand-over is counted, so a reminder that fired behind him shows as
    // two.
    const owed = await state(harnessed, orderId);
    expect(owed?.dispatch.attempts).toBe(1);
    expect(owed?.dispatch.accepted).toBe(true);
    expect(owed?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "async_fulfillment",
    });
  });

  it("does not close an order on the silence after a repeat its merchant had already taken on", async () => {
    // A slow handler may accept after our answer wait has expired, and the repeat
    // sent for that silence is ordinary. The silence after the repeat must not
    // count once he has accepted, or a slow but willing merchant runs out of
    // deliveries and sees a paid order close into a refund while he fills it.
    // Each step is driven by hand so the order of events is the same every run.
    const harnessed = await started({
      // Long enough that the gateway's own reminders never fire: the two
      // silences below are the only input.
      HANDLER_ANSWER_MS: "60000",
      REDELIVERY_BASE_DELAY_MS: "5",
      // Two deliveries, so counting the second silence would close the order.
      REDELIVERY_MAX_ATTEMPTS: "2",
      DEFAULT_ASYNC_FULFILLMENT_MS: "60000",
    });
    const merchantId = harnessed.merchant.id;
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    const openHandOver = async (): Promise<string> => {
      const handOver = (await harnessed.store.orderById(orderId))?.openDeliveryId ?? null;
      if (handOver === null) throw new Error("no hand-over is open to go quiet");
      return handOver;
    };

    // The first hand-over goes quiet for longer than we wait, and the repeat
    // is decided on.
    expect((await harnessed.gateway.poll(merchantId, 1_000)).envelopes).toHaveLength(1);
    await harnessed.queue.remind(
      { kind: "delivery_unanswered", orderId, handOver: await openHandOver() },
      0,
    );
    await vi.waitFor(
      async () => expect(await harnessed.queue.holdsOrder(merchantId, orderId)).toBe(true),
      { timeout: 2_000, interval: 5 },
    );

    // Then the acceptance lands, with the repeat already on the stream, and
    // the repeat still reaches him.
    await harnessed.gateway.answerOrder(merchantId, orderId, { accepted: {} });
    expect((await harnessed.gateway.poll(merchantId, 1_000)).envelopes).toHaveLength(1);

    // The silence after the repeat, then the goods. This relies on the in-memory
    // adapters: the reminder fires on the next event-loop turn and takes the
    // order's hold, so the delivery waits behind it. If the delivery ever went
    // first, this would pass whether or not the silence is counted.
    await harnessed.queue.remind(
      { kind: "delivery_unanswered", orderId, handOver: await openHandOver() },
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const delivered = await harnessed.gateway.deliverOrder(merchantId, orderId, {
      activation_code: "LPA:1$smdp.example$K2-1A2B3C",
    });

    // Had the silence counted, the order would already owe a refund, and his
    // goods would pay off a debt rather than make a sale.
    expect(delivered).toStrictEqual({ ok: true, result: "delivered" });
    // Events are never taken back, so a refund notice sent in error would stand
    // in his records whatever happened to the order afterwards.
    expect((await harnessed.queue.draw(merchantId, 10, 0)).map((d) => d.envelope)).toStrictEqual(
      [],
    );
    expect((await state(harnessed, orderId))?.dispatch).toStrictEqual({
      attempts: 2,
      accepted: true,
    });
  });

  it("spends one delivery on one silence, though the same reminder arrives twice", async () => {
    // The queue hands a reminder out again when whoever took it never completed
    // it. Every hand-over counts against the attempt cap, and reaching the cap
    // closes a paid order into a refund, so a second arrival of the same
    // reminder must cost nothing.
    const harnessed = await started({
      // Long enough that the gateway's own reminder never fires: the two
      // arrivals below are the only input.
      HANDLER_ANSWER_MS: "60000",
      REDELIVERY_BASE_DELAY_MS: "5",
      DEFAULT_ASYNC_FULFILLMENT_MS: "60000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    // One hand-over, drawn and answered by nobody.
    const handed = await harnessed.gateway.poll(harnessed.merchant.id, 1_000);
    expect(handed.envelopes).toHaveLength(1);
    const handOver = (await harnessed.store.orderById(orderId))?.openDeliveryId ?? null;
    if (handOver === null) {
      throw new Error("the hand-over was not recorded, so there is nothing to remind against");
    }

    // The same reminder, put on the queue twice. The in-memory queue repeats a
    // reminder only when its handler throws, and one that decided on a
    // redelivery did not, so this is how a database queue's repeat is reproduced.
    const unanswered: Reminder = { kind: "delivery_unanswered", orderId, handOver };
    await harnessed.queue.remind(unanswered, 0);
    await vi.waitFor(
      async () =>
        expect(await harnessed.queue.holdsOrder(harnessed.merchant.id, orderId)).toBe(true),
      { timeout: 2_000, interval: 5 },
    );
    await harnessed.queue.remind(unanswered, 0);
    // Long enough for the second arrival to be handled and for any redelivery it
    // decided on to come off its delay.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // One silence, one repeat; two envelopes would spend two of his attempts.
    const again = await harnessed.gateway.poll(harnessed.merchant.id, 100);
    expect(again.envelopes).toHaveLength(1);
    expect((await state(harnessed, orderId))?.dispatch.attempts).toBe(2);
  });

  it("sends the order again when the next hand-over goes quiet in its turn", async () => {
    // The negative control: each redelivery arms a hand-over of its own, and
    // silence on that one is worth another delivery. A guard shut for the whole
    // order would leave it in `dispatched` with attempts stuck at two.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      REDELIVERY_BASE_DELAY_MS: "5",
      DEFAULT_ASYNC_FULFILLMENT_MS: "60000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    // A worker that draws its stream and answers nothing, silence after silence.
    const silent = workUntilStopped(harnessed, {});
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.dispatch.attempts).toBeGreaterThan(2),
      { timeout: 2_000, interval: 5 },
    );
    await silent.stop();

    expect((await state(harnessed, orderId))?.state).toBe("dispatched");
  });
});

describe("a burst of orders", () => {
  it("waits for each answer from the moment that order was handed over, not the burst", async () => {
    // A worker handles orders one at a time. If the answer wait started for a
    // whole burst at once, orders at the back would be taken for silences before
    // their handler had started, and each would lose a delivery attempt.
    const harnessed = await started({
      // Eight times what one handler call takes, so only a wait that also
      // covers the calls ahead of an order can run out.
      HANDLER_ANSWER_MS: "200",
      REDELIVERY_BASE_DELAY_MS: "5",
      DEFAULT_ASYNC_FULFILLMENT_MS: "60000",
    });
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, asyncCard);
    if (!published.ok) throw new Error("the card would not publish");
    const orderIds: string[] = [];
    for (let nth = 0; nth < 12; nth += 1) {
      const offered = await harnessed.gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      // One payment buys one order, so each purchase brings its own.
      await harnessed.gateway.payPurchase(
        offered.order.order.id,
        `PAYMENT-${nth}`,
        `PAYMENT-${nth}`,
      );
      orderIds.push(offered.order.order.id);
    }

    const quick = workUntilStopped(harnessed, {
      onOrder: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { accepted: {} };
      },
    });
    // A repeat sits on the stream until drawn, so this is not reached until every
    // repeat has been handed over and counted below.
    await vi.waitFor(
      async () => {
        for (const orderId of orderIds) {
          expect((await state(harnessed, orderId))?.dispatch.accepted).toBe(true);
          expect(await harnessed.queue.holdsOrder(harnessed.merchant.id, orderId)).toBe(false);
        }
      },
      { timeout: 5_000, interval: 10 },
    );
    await quick.stop();

    const handed: Record<string, number | undefined> = {};
    for (const orderId of orderIds) {
      handed[orderId] = (await state(harnessed, orderId))?.dispatch.attempts;
    }
    expect(handed).toStrictEqual(Object.fromEntries(orderIds.map((orderId) => [orderId, 1])));
  });

  it("answers with what is live behind an envelope that has gone stale, rather than nothing", async () => {
    // A closed order's envelope is skipped. A poll that answered empty for it
    // would send the worker to rest as if the stream were quiet, a second each in
    // the SDK, while live orders waited behind it.
    const harnessed = await started();
    // A synchronous purchase nobody draws in time: it closes at its deadline,
    // and its envelope stays at the head of the stream.
    const closed = await bought(harnessed, syncCard);
    await harnessed.gateway.payPurchase(closed, "PAYMENT-0", "PAYMENT-0");
    expect((await state(harnessed, closed))?.state).toBe("expired");
    const live = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(live, "PAYMENT-1", "PAYMENT-1");

    // A drain: whatever is there right now.
    const first = await harnessed.gateway.poll(harnessed.merchant.id, 0);
    expect(first.envelopes).toHaveLength(1);
    const handed = [...first.envelopes, ...(await drawEverything(harnessed))].flatMap((each) =>
      each.kind === "order" ? [each.payload.id] : [],
    );
    expect(handed).toStrictEqual([live]);
  });

  describe("when no hand-over can be recorded", () => {
    // The store fails every write, slowly, and each envelope goes back on the
    // stream sooner than the others take to draw, so there is always one to
    // draw. A poll that drew until it could hand something out would never end.
    const failing = async () => {
      const harnessed = await started({ SETTLE_IN_FLIGHT_RETRY_MS: "50" });
      for (const nth of [0, 1, 2]) {
        const orderId = await bought(harnessed, asyncCard);
        await harnessed.gateway.payPurchase(orderId, `PAYMENT-${nth}`, `PAYMENT-${nth}`);
      }
      vi.spyOn(harnessed.store, "withOrder").mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error("the database timed out");
      });
      return harnessed;
    };
    const stillDrawing = (ms: number) =>
      new Promise<"still drawing">((resolve) => setTimeout(() => resolve("still drawing"), ms));

    it("answers a held poll once its window is over", async () => {
      const harnessed = await failing();
      const startedAt = performance.now();
      const answered = await Promise.race([
        harnessed.gateway.poll(harnessed.merchant.id, 100),
        stillDrawing(2_000),
      ]);
      const took = performance.now() - startedAt;

      expect(answered).toStrictEqual({ contract_version: expect.any(String), envelopes: [] });
      // The window plus at most one more pass.
      expect(took).toBeLessThan(500);
    });

    it("answers a drain after a bounded number of envelopes", async () => {
      const harnessed = await failing();
      const answered = await Promise.race([
        harnessed.gateway.poll(harnessed.merchant.id, 0),
        stillDrawing(3_000),
      ]);

      expect(answered).toStrictEqual({ contract_version: expect.any(String), envelopes: [] });
    });
  });
});

describe("a timer that fires at the wrong moment", () => {
  it("hands the machine's refusal back rather than closing the order on it", async () => {
    // A stale reminder, or one for a clock this order never had, must not close
    // it. Which timers are refused is tested in `packages/core`; here the runner
    // must hand the machine's refusal and code back and write nothing.
    const harnessed = await started();
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, { activation_code: "A" });

    const refused = await harnessed.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      at: harnessed.now() + 1_000_000,
      deadline: "async_fulfillment",
    });

    expect(refused.outcome).toBe("refused");
    if (refused.outcome !== "refused") throw new Error("the stale timer was taken");
    expect(refused.rejection.code).toBe("deadline_not_armed");
    expect((await state(harnessed, orderId))?.state).toBe("delivered");
  });
});

describe("a reminder that could not be carried out", () => {
  it("is asked for again rather than lost in silence", async () => {
    // A reminder is the only thing that declares an order overdue, so one
    // dropped on a brief store outage is a paid order never marked for a refund.
    const harnessed = await started({
      DEFAULT_ASYNC_FULFILLMENT_MS: "20",
      REDELIVERY_BASE_DELAY_MS: "5",
      REMINDER_ATTEMPTS: "3",
      // The queue takes both of these from the configuration, so a test that
      // set one and watched the other would be asserting against a default.
      REMINDER_RETRY_DELAY_MS: "5",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    // The store fails the first two times the reminder tries to move the order.
    const deciding = harnessed.store.withOrder.bind(harnessed.store);
    let failures = 0;
    harnessed.store.withOrder = (async (id: string, change: never) => {
      if (failures < 2) {
        failures += 1;
        throw new Error("the store was briefly unreachable");
      }
      return deciding(id, change);
    }) as typeof harnessed.store.withOrder;

    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      {
        timeout: 2_000,
        interval: 5,
      },
    );
    expect(failures).toBe(2);
  });
});
