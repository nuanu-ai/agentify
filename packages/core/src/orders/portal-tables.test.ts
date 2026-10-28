import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REDELIVERY_MAX_ATTEMPTS } from "../published.js";
import { deadlines } from "./deadlines.js";
import { must, newOrder, reach, T0, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Order } from "./model.js";
import { endingReasonFor, outcomeFor } from "./outcome.js";
import { nextRedelivery } from "./redelivery.js";

/** The machine is held to the actual displayed cells, including every status/event token and each clock's anchor. Transport recovery and wallet authorisation remain Gateway contracts. */

const ORDERS_PAGE = readFileSync(
  new URL("../../../../apps/docs/orders.md", import.meta.url),
  "utf8",
);
const FAILURES_PAGE = readFileSync(
  new URL("../../../../apps/docs/failures.md", import.meta.url),
  "utf8",
);

function section(page: string, heading: string): string {
  const lines = page.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`the portal has no section "${heading}"`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * Every data row of the first table in a section, each as its cells, the
 * header's cells first.
 */
function tableOf(page: string, heading: string): readonly (readonly string[])[] {
  const lines = section(page, heading).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  if (first === -1) throw new Error(`the section "${heading}" has no table`);

  const rows: string[][] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith("|")) break;
    // A row is bounded by a pipe at each end, so splitting it leaves an empty
    // piece on both sides.
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((piece) => piece.trim());
    if (/^:?-+:?$/.test(cells[0] ?? "")) continue;
    rows.push(cells);
  }
  return rows;
}

/**
 * The first cell of every data row of the first table in a section: what each
 * row is about, which is what the scenarios above are named by.
 */
function tableRows(page: string, heading: string): readonly string[] {
  return tableOf(page, heading)
    .slice(1)
    .map((cells) => cells[0] ?? "");
}

/**
 * The words in backticks in one column of one row, found by the row's first
 * cell and the column's heading: the status words the page promises for a
 * situation, which the scenario then holds the machine to.
 */
function wordsIn(page: string, heading: string, row: string, column: string): readonly string[] {
  const [header = [], ...rows] = tableOf(page, heading);
  const at = header.indexOf(column);
  if (at === -1) throw new Error(`the table under "${heading}" has no column ${column}`);
  const cells = rows.find((each) => each[0] === row);
  if (cells === undefined) throw new Error(`the table under "${heading}" has no row "${row}"`);
  return [...(cells[at] ?? "").matchAll(/`([^`]+)`/g)].map((found) => found[1] ?? "");
}

function rowOf(page: string, heading: string, name: string | undefined): readonly string[] {
  const row = tableOf(page, heading)
    .slice(1)
    .find((row) => row[0] === name);
  if (row === undefined || row.some((cell) => cell.length === 0))
    throw new Error(`missing complete ${heading} row ${name}`);
  return row;
}
const limitRow = (index: number) => rowOf(ORDERS_PAGE, "Every time limit", TIME_LIMITS[index]);
const failureRow = (index: number) =>
  rowOf(FAILURES_PAGE, "Every failure, mode by mode", FAILURES[index]);
const resultWords = (index: number) =>
  wordsIn(ORDERS_PAGE, "Every time limit", TIME_LIMITS[index] ?? "", "When it runs out");
function retryPromise(order: Order): void {
  const first = must(order, { kind: "handler_undelivered", at: T0 + 4 });
  expect(first.effects).toContainEqual({
    kind: "redeliver_order",
    attempt: order.dispatch.attempts + 1,
    delayMs: order.policy.redelivery.baseDelayMs,
  });
  expect(order.policy.redelivery.maxAttempts).toBe(REDELIVERY_MAX_ATTEMPTS);
  const policy = order.policy.redelivery;
  const delays = [1, 2, 3].map((attempts) =>
    nextRedelivery({ attempts, now: T0, deadlineAt: null, policy }),
  );
  expect(delays.map((retry) => (retry.retry ? retry.delayMs : null))).toEqual([
    policy.baseDelayMs,
    policy.baseDelayMs * policy.factor,
    policy.baseDelayMs * policy.factor ** 2,
  ]);
  expect(
    nextRedelivery({ attempts: REDELIVERY_MAX_ATTEMPTS, now: T0, deadlineAt: null, policy }).retry,
  ).toBe(false);
  expect(
    nextRedelivery({ attempts: 1, now: T0, deadlineAt: T0 + policy.baseDelayMs, policy }).retry,
  ).toBe(false);
}

function paidAsync(): Order {
  return walk(newOrder("async"), [
    { kind: "payment_verified", at: T0 + 1 },
    { kind: "payment_settled", at: T0 + 2 },
    { kind: "order_dispatched", at: T0 + 3 },
    { kind: "handler_accepted", at: T0 + 4 },
  ]);
}

// --- apps/docs/orders.md, "How an order can end" -----------------------------

const ENDINGS = [
  "You delivered the goods",
  "You recorded a parcel's shipment",
  "A charge failed before the goods, or you refused in the synchronous mode",
  "No synchronous delivery arrived by its deadline",
  "The money was charged and no delivery happened",
  "You delivered synchronously and the payment did not execute",
  "The facilitator did not say whether the money was charged",
  "You closed fulfillment",
] as const;

/** The status words the page promises for one of its endings. */
const statusOf = (ending: (typeof ENDINGS)[number]): readonly string[] =>
  wordsIn(ORDERS_PAGE, "How an order can end", ending, "`status`");

function paidParcel(): Order {
  return walk(
    newOrder("async", {
      mode: { settle: "on_purchase", parcel: true },
      priceCheck: "merchant",
    }),
    [
      {
        kind: "quote_answered",
        at: T0 + 1,
        available: true,
        price: { amount: "21.00", currency: "USD", asOf: T0 },
      },
      { kind: "payment_verified", at: T0 + 2 },
      { kind: "payment_settled", at: T0 + 3 },
      { kind: "order_dispatched", at: T0 + 4 },
      { kind: "handler_accepted", at: T0 + 5 },
    ],
  );
}

describe('apps/docs/orders.md, "How an order can end"', () => {
  it(`${ENDINGS[7]}: closure preserves payment and stops future fulfillment`, () => {
    expect(tableRows(ORDERS_PAGE, "How an order can end")).toHaveLength(ENDINGS.length);
    const paid = reach("unfulfilled");
    const closed = must(paid, { kind: "close_called", at: T0 + 10 }).order;
    const unresolved = must(reach("fulfilled"), { kind: "close_called", at: T0 + 10 }).order;
    expect(statusOf(ENDINGS[7])).toStrictEqual([outcomeFor(closed), outcomeFor(unresolved)]);
    expect(closed.payment).toBe(paid.payment);
  });

  it(`${ENDINGS[0]}: the money is the merchant's, the agent has goods and a receipt`, () => {
    const { order } = must(paidAsync(), { kind: "deliver_called", at: T0 + 60 });

    expect(statusOf(ENDINGS[0])).toStrictEqual([outcomeFor(order)]);
    expect(outcomeFor(order)).toBe("delivered");
  });

  it(`${ENDINGS[1]}: the money is the merchant's, and the agent is told the parcel shipped`, () => {
    // Not "delivered": nothing reached the agent, and the shipment is the last
    // thing anybody here knows about the parcel.
    const { order } = must(paidParcel(), { kind: "deliver_called", at: T0 + 60 });

    expect(statusOf(ENDINGS[1])).toStrictEqual([outcomeFor(order)]);
    expect(outcomeFor(order)).toBe("shipped");
  });

  it(`${ENDINGS[2]}: nothing moved, and the agent sees a refusal`, () => {
    // Price refusal happens before an order is written. This row covers a
    // handler's synchronous refusal and a charge refused before fulfillment.
    const refusedTheParams = must(reach("dispatched"), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "invalid_params",
      message: "the address does not parse",
    }).order;
    const refusedCharge = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settle_failed", at: T0 + 2 },
    ]);

    for (const order of [refusedTheParams, refusedCharge]) {
      expect(statusOf(ENDINGS[2]), `from ${order.state}`).toStrictEqual([outcomeFor(order)]);
    }
  });

  it(`${ENDINGS[3]}: the order is closed on time and nothing moved`, () => {
    const noSyncGoods = must(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "sync_response",
    }).order;

    expect(statusOf(ENDINGS[3])).toStrictEqual([outcomeFor(noSyncGoods)]);
  });

  it(`${ENDINGS[4]}: the money is the merchant's and the order is unfulfilled`, () => {
    expect(statusOf(ENDINGS[4])).toStrictEqual([outcomeFor(reach("unfulfilled"))]);
  });

  it(`${ENDINGS[6]}: the agent is told the outcome is unknown, not that he was refused`, () => {
    // The row promises "the outcome of the payment is not known", not
    // "refused". To an agent deciding whether to buy the same thing elsewhere
    // these are different answers, and the machine may not give the cheaper one
    // when it does not know.
    const unresolved = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(statusOf(ENDINGS[6])).toStrictEqual([outcomeFor(unresolved)]);
    expect(outcomeFor(unresolved)).not.toBe("rejected");

    // And the row's promise that a repeat with the same key is safe: it costs
    // the buyer nothing, because no second charge is sent over the first.
    const repeated = transition(unresolved, { kind: "purchase_repeated", at: T0 + 1_000_000 });

    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.effects).toStrictEqual([]);
  });

  it(`${ENDINGS[5]}: the money never came, and a repeat drives the payment home`, () => {
    const order = reach("delivered_unpaid");

    expect(statusOf(ENDINGS[5])).toStrictEqual([outcomeFor(order)]);
    // The agent is told why, which the page's last cell promises.
    expect(endingReasonFor(order)).toBe("payment_not_settled");

    const closed = walk(order, [
      { kind: "purchase_repeated", at: T0 + 6 },
      { kind: "payment_verified", at: T0 + 7 },
      { kind: "payment_settled", at: T0 + 8 },
    ]);

    expect(outcomeFor(closed)).toBe("delivered");
  });

  it(`${ENDINGS[5]}: where the charge went unanswered instead, the repeat waits`, () => {
    // The other half of the portal's "You delivered and the payment did not
    // execute". The same merchant event carries both, so the page sends the
    // merchant to the order's own word to tell them apart, and the two words
    // have to be the two below or a merchant follows the wrong paragraph.
    const { order } = must(reach("fulfilled"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    });

    // The word the page tells him to read: not `delivered_unpaid`, which is
    // the paragraph with the repeat in it, and not `in_progress`, which is an
    // order still waiting on him.
    expect(statusOf(ENDINGS[6])).toStrictEqual([outcomeFor(order)]);

    // "A repeat purchase is refused": no second charge goes out on a guess
    // about the first.
    expect(transition(order, { kind: "purchase_repeated", at: T0 + 1_000_000 }).ok).toBe(false);

    // "If a late answer says the money moved, the order closes as delivered
    // and the agent gets its goods."
    const paid = must(order, { kind: "payment_settled", at: T0 + 2_000_000 });

    expect(outcomeFor(paid.order)).toBe("delivered");

    // No clock is left running on it. The page promises the merchant nothing
    // on our side will close this order on a guess about the charge, and a
    // deadline that expired here would be exactly that guess.
    expect(deadlines(order)).toStrictEqual([]);
  });
});

// --- apps/docs/orders.md, "Every time limit" ----------------------------------

const TIME_LIMITS = [
  "Your price handler's answer",
  "The price offered to the agent",
  "Each hand-over of an order to your process",
  "The goods of a synchronous order",
  "The facilitator's answer about the charge",
  "The delivery of an asynchronous order",
  "The shipment of a parcel",
] as const;

describe('apps/docs/orders.md, "Every time limit"', () => {
  it(`${TIME_LIMITS[0]}: a synchronous card sells at its own price, the others are refused`, () => {
    expect(tableRows(ORDERS_PAGE, "Every time limit")).toHaveLength(TIME_LIMITS.length);
    const row = limitRow(0);
    expect(row[2]).toBe("{{quote-response}}");
    expect(row[3]).toMatch(/question.*asked/i);
    expect(row[4]).toMatch(/synchronous.*own price/i);
    expect(row[4]).toMatch(/refused before payment/i);
    const waiting = newOrder("sync", { priceCheck: "merchant" });
    expect(deadlines(waiting)).toEqual([
      {
        kind: "quote_response",
        at: waiting.timestamps.createdAt + waiting.policy.deadlines.quoteResponseMs,
      },
    ]);
    const silent = (order: Order) => must(order, { kind: "quote_silent", at: T0 + 1 }).order;
    const sync = silent(newOrder("sync", { priceCheck: "merchant" }));
    const async = silent(newOrder("async", { priceCheck: "merchant" }));
    const parcel = silent(
      newOrder("async", {
        mode: { settle: "on_purchase", parcel: true },
        priceCheck: "merchant",
      }),
    );

    expect(outcomeFor(sync)).toBe("in_progress");
    expect(row[4]).toMatch(/no order.*written/i);
    expect(resultWords(0)).toEqual([]);
    for (const refused of [async, parcel]) {
      expect(outcomeFor(refused)).toBe("rejected");
      expect(endingReasonFor(refused)).toBe("price_check_unanswered");
    }
  });

  it(`${TIME_LIMITS[1]}: admission uses the paid request's arrival before the term ends`, () => {
    expect(limitRow(1)[2]).toBe("{{quote-ttl}}");
    expect(limitRow(1)[3]).toMatch(/your answer.*silence.*agent's request/i);
    expect(limitRow(1)[4]).toMatch(/paid request.*arrive.*before.*term ends.*no order.*written/i);
    expect(resultWords(1)).toEqual([]);
    const quoted = newOrder("sync");
    const until = T0 + quoted.policy.deadlines.quoteTtlMs;
    const admitted = must(quoted, { kind: "payment_presented", at: until - 1 }).order;
    const late = transition(quoted, { kind: "payment_presented", at: until });

    expect(admitted.timestamps.paymentPresentedAt).toBe(until - 1);
    expect(deadlines(admitted)).toStrictEqual([]);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.rejection.code).toBe("event_not_applicable");
  });

  it(`${TIME_LIMITS[2]}: the order comes again rather than closing`, () => {
    const row = limitRow(2);
    expect(row[2]).toBe("{{handler-answer}}");
    expect(row[3]).toMatch(/handed to your process/i);
    expect(row[4]).toMatch(/sent again.*{{redelivery-max-attempts}}.*deadline/i);
    retryPromise(reach("dispatched"));
    // An answer that did not come back is not an answer, so the agent is not
    // told his purchase failed: it is still going, and the order goes back to
    // the merchant.
    const { order } = must(reach("dispatched"), { kind: "handler_undelivered", at: T0 + 4 });

    expect(outcomeFor(order)).toBe("in_progress");
  });

  it(`${TIME_LIMITS[3]}: nothing is charged, and late goods are not lost`, () => {
    expect(limitRow(3)[2]).toBe("{{sync-response}}");
    expect(limitRow(3)[3]).toMatch(/payment checked out/i);
    expect(limitRow(3)[4]).toMatch(/nothing is charged.*same buyer.*pays.*unless.*closed/i);
    const dispatched = reach("dispatched");
    expect(deadlines(dispatched)).toEqual([
      {
        kind: "sync_response",
        at: (dispatched.timestamps.paidAt ?? NaN) + dispatched.policy.deadlines.syncResponseMs,
      },
    ]);
    const closed = must(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "sync_response",
    }).order;

    expect(resultWords(3)).toEqual([outcomeFor(closed), endingReasonFor(closed)]);
    expect(endingReasonFor(closed)).toBe("merchant_timed_out");

    // The second half of the row, and the one the agent is promised: goods
    // that arrive after the deadline are not thrown away, and a repeat of the
    // purchase collects them.
    const picked = walk(closed, [
      { kind: "handler_delivered", at: T0 + 1_000_000 },
      { kind: "purchase_repeated", at: T0 + 1_000_001 },
      { kind: "payment_verified", at: T0 + 1_000_002 },
      { kind: "payment_settled", at: T0 + 1_000_003 },
    ]);

    expect(outcomeFor(picked)).toBe("delivered");
  });

  it(`${TIME_LIMITS[4]}: nobody can say whether the buyer was charged`, () => {
    expect(limitRow(4)[2]).toMatch(/{{settle-response}}.*{{settle-before-goods:number}}/);
    expect(limitRow(4)[3]).toMatch(/charge is sent/i);
    const settling = must(newOrder("async"), { kind: "payment_verified", at: T0 + 1 }).order;
    expect(deadlines(settling)).toEqual([
      {
        kind: "settle_response",
        at:
          (settling.timestamps.settleStartedAt ?? NaN) + settling.policy.deadlines.settleResponseMs,
      },
    ]);
    const afterTheGoods = must(reach("fulfilled"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    }).order;
    const beforeTheGoods = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(resultWords(4)).toEqual([outcomeFor(afterTheGoods)]);
    expect(resultWords(4)).toEqual([outcomeFor(beforeTheGoods)]);
  });

  it(`${TIME_LIMITS[5]}: the money is already the merchant's and the order is unfulfilled`, () => {
    expect(limitRow(5)[2]).toMatch(/card names.*{{default-async-fulfillment}}/);
    expect(limitRow(5)[3]).toMatch(/charge at purchase/i);
    const paid = paidAsync();
    expect(deadlines(paid)).toEqual([
      {
        kind: "async_fulfillment",
        at: (paid.timestamps.paidAt ?? NaN) + paid.policy.deadlines.asyncFulfillmentMs,
      },
    ]);
    const { order } = must(paidAsync(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(resultWords(5)).toEqual([outcomeFor(order)]);
  });

  it(`${TIME_LIMITS[6]}: a parcel not shipped in time is unfulfilled as well`, () => {
    expect(limitRow(6)[2]).toMatch(/`ship_within_seconds`.*at most thirty days/i);
    expect(limitRow(6)[3]).toMatch(/charge at purchase/i);
    const paid = paidParcel();
    expect(deadlines(paid)).toEqual([
      {
        kind: "async_fulfillment",
        at: (paid.timestamps.paidAt ?? NaN) + paid.policy.deadlines.asyncFulfillmentMs,
      },
    ]);
    const { order } = must(paidParcel(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(resultWords(6)).toEqual([outcomeFor(order)]);
  });
});

// --- apps/docs/orders.md, "Events on the same subscription" -------------------

const EVENTS = [
  "A paid order was left unfulfilled",
  "A payment did not execute after a synchronous delivery",
] as const;

/** The event the page says a situation arrives as, which the machine has to emit. */
const sentAs = (event: (typeof EVENTS)[number]) =>
  wordsIn(ORDERS_PAGE, "Events on the same subscription", event, "`type`").map((type) => ({
    kind: "emit_merchant_event",
    event: type,
  }));

describe('apps/docs/orders.md, "Events on the same subscription"', () => {
  it(`${EVENTS[0]}: sent when the goods did not come in time`, () => {
    const { effects } = must(paidAsync(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(tableRows(ORDERS_PAGE, "Events on the same subscription")).toHaveLength(EVENTS.length);
    expect(effects.filter((effect) => effect.kind === "emit_merchant_event")).toEqual(
      sentAs(EVENTS[0]),
    );
  });

  it(`${EVENTS[1]}: sent when the goods went out and the money did not arrive`, () => {
    const { effects } = must(reach("fulfilled"), { kind: "payment_settle_failed", at: T0 + 5 });

    expect(effects.filter((effect) => effect.kind === "emit_merchant_event")).toEqual(
      sentAs(EVENTS[1]),
    );
  });
});

// --- apps/docs/failures.md, "Every failure, mode by mode" --------------------

const FAILURES = [
  "The price check is silent",
  "You refused",
  "Your handler threw, or your process fell over",
  "No answer by the deadline",
  "The same order arrived twice",
  "The answer to the agent was lost",
  "The goods ran out",
  "The charge failed after your delivery",
  "Nobody knows whether the charge went through",
] as const;

/**
 * The rows about a purchase refused before any order exists, which this
 * machine never sees: their scenarios are the gateway's, in
 * `apps/gateway/src/http/purchase-door.test.ts`. They are named as the source
 * writes them, with the number the build writes in.
 */
const AT_THE_DOOR = [
  "Your price-question gate is full",
  "No process of yours has polled for {{silent-after}}",
  "{{Unserved-at-most}} paid orders you took on are left without delivery or closure",
] as const;

function priceCheckedParcel(): Order {
  return newOrder("async", {
    mode: { settle: "on_purchase", parcel: true },
    priceCheck: "merchant",
  });
}

describe('apps/docs/failures.md, "Every failure, mode by mode"', () => {
  it(`${FAILURES[0]}: the sale goes on where the money is still ahead of it`, () => {
    expect(tableRows(FAILURES_PAGE, "Every failure, mode by mode")).toHaveLength(
      FAILURES.length + AT_THE_DOOR.length,
    );
    const row = failureRow(0);
    expect(row[1]).toMatch(/sale goes on.*card's price/i);
    expect(row[2]).toMatch(/refused before payment.*no order/i);
    expect(row[3]).toMatch(/asynchronous/i);
    const gate = rowOf(FAILURES_PAGE, "Every failure, mode by mode", AT_THE_DOOR[0]);
    expect(gate[1]).toMatch(/sale goes on.*card's price.*without asking/i);
    expect(gate[2]).toContain("`seller_busy`");
    expect(gate[2]).toMatch(/HTTP 429.*`Retry-After: 2`/);
    expect(gate[2]).toMatch(/before.*order is written/i);
    expect(gate[3]).toMatch(/asynchronous/i);
    for (const [name, code] of [
      [AT_THE_DOOR[1], "seller_not_taking_orders"],
      [AT_THE_DOOR[2], "seller_not_fulfilling"],
    ] as const) {
      const cells = rowOf(FAILURES_PAGE, "Every failure, mode by mode", name);
      expect(cells[1]).toContain(`\`${code}\``);
      expect(cells[1]).toMatch(/before.*order exists/i);
    }
    const silent = (order: Order) => must(order, { kind: "quote_silent", at: T0 + 1 }).order;

    // The synchronous sale goes on and the two that charge at purchase do
    // not, which is the whole row: where the merchant's live answer still
    // stands between the price and the charge, a second of silence does not
    // cancel a sale that can be made honestly at the card's own price.
    expect(outcomeFor(silent(newOrder("sync", { priceCheck: "merchant" })))).toBe("in_progress");
    expect(outcomeFor(silent(newOrder("async", { priceCheck: "merchant" })))).toBe("rejected");
    expect(outcomeFor(silent(priceCheckedParcel()))).toBe("rejected");
  });

  it(`${FAILURES[1]}: what a refusal costs depends on whether the money moved`, () => {
    const row = failureRow(1);
    expect(row[1]).toMatch(/nothing was charged/i);
    expect(row[2]).toContain("`unfulfilled`");
    expect(row[3]).toMatch(/asynchronous/i);
    const inSync = must(reach("dispatched"), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "cannot_fulfill",
      message: "no",
    }).order;
    const afterTheCharge = must(paidAsync(), {
      kind: "refuse_called",
      at: T0 + 5,
      code: "out_of_stock",
      message: "no",
    }).order;

    expect(outcomeFor(inSync)).toBe("rejected");
    expect(row[2]).toContain(`\`${outcomeFor(afterTheCharge)}\``);
    const parcel = must(paidParcel(), {
      kind: "refuse_called",
      at: T0 + 6,
      code: "out_of_stock",
      message: "none",
    });
    expect(outcomeFor(parcel.order)).toBe(outcomeFor(afterTheCharge));
    expect(parcel.effects.some((effect) => effect.kind === "execute_payment")).toBe(false);
  });

  it(`${FAILURES[2]}: the order comes again rather than closing`, () => {
    const row = failureRow(2);
    expect(row[1]).toMatch(/pause.*grows.*{{redelivery-max-attempts}}.*deadline/i);
    expect(row.slice(2, 4).every((cell) => /synchronous/.test(cell))).toBe(true);
    retryPromise(reach("dispatched"));
    // An exception is not an answer, so the agent is not told his purchase
    // failed: it is still going, and the order goes back to the merchant.
    const { order } = must(reach("dispatched"), { kind: "handler_undelivered", at: T0 + 4 });

    expect(outcomeFor(order)).toBe("in_progress");
  });

  it(`${FAILURES[3]}: silence ends the same way a refusal does, only on time`, () => {
    const row = failureRow(3);
    expect(row[1]).toMatch(/nothing was charged.*`expired`/i);
    expect(row[2]).toContain("`unfulfilled`");
    expect(row[3]).toContain("`unfulfilled`");
    const parcel = must(paidParcel(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });
    expect(row[3]).toContain(`\`${outcomeFor(parcel.order)}\``);
    const sync = must(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "sync_response",
    }).order;
    const async = must(paidAsync(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    }).order;

    expect(outcomeFor(sync)).toBe("expired");
    expect(outcomeFor(async)).toBe("unfulfilled");
  });

  it(`${FAILURES[4]}: no second fulfillment and no second charge`, () => {
    const row = failureRow(4);
    expect(row[1]).toMatch(/result.*first/i);
    expect(row[2]).toMatch(/synchronous/i);
    expect(row[3]).toMatch(/same shipment/i);
    const parcel = must(paidParcel(), { kind: "deliver_called", at: T0 + 6 });
    const repeatedParcel = must(parcel.order, { kind: "deliver_called", at: T0 + 7 });
    expect(repeatedParcel.order).toEqual(parcel.order);
    expect(repeatedParcel.effects.every((effect) => effect.kind === "answer_merchant")).toBe(true);
    // The race the row is written for. A redelivery goes out while the first
    // handler is still working — the order is open, so the second hand-over is
    // taken and counted — and the two of them then answer the same order one
    // after the other. It is the second answer that the row is a promise
    // about: the buyer keeps the goods the first one carried, and the money
    // does not move again.
    const open = paidAsync();
    const again = must(open, { kind: "order_dispatched", at: T0 + 5 });

    expect(again.order.dispatch.attempts).toBe(open.dispatch.attempts + 1);

    const delivered = must(again.order, { kind: "deliver_called", at: T0 + 6 });
    const repeat = must(delivered.order, { kind: "deliver_called", at: T0 + 7 });

    expect(outcomeFor(repeat.order)).toBe("delivered");
    // Nothing but the answer: no goods released a second time, no receipt
    // written over the first and nothing sent for execution.
    expect(repeat.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "already_delivered" } },
    ]);
  });

  it(`${FAILURES[5]}: the repeat gets what is already there`, () => {
    const row = failureRow(5);
    for (const cell of row.slice(1, 3)) {
      expect(cell).toMatch(/signs a new payment.*same payment request.*same wallet/i);
      expect(cell).toMatch(/no second charge/i);
      expect(cell).toMatch(/without that request.*new purchase.*charged again/i);
    }
    expect(row[3]).toMatch(/asynchronous/i);
    const delivered = reach("delivered");
    const { order, effects } = must(delivered, { kind: "purchase_repeated", at: T0 + 99 });

    expect(outcomeFor(order)).toBe("delivered");
    expect(effects).toEqual([]);
  });

  it(`${FAILURES[6]}: said in the price check, the buyer's money does not move`, () => {
    const row = failureRow(6);
    expect(row[1]).toMatch(/price check.*before payment.*delivery charges nothing/i);
    expect(row[2]).toMatch(/price check.*before payment.*paid order unfulfilled/i);
    expect(row[3]).toMatch(/asynchronous/i);
    const refused = must(reach("dispatched"), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "out_of_stock",
      message: "none",
    });
    expect(outcomeFor(refused.order)).toBe("rejected");
    expect(refused.effects.some((effect) => effect.kind === "execute_payment")).toBe(false);
    for (const paid of [paidAsync(), paidParcel()])
      expect(
        outcomeFor(
          must(paid, { kind: "refuse_called", at: T0 + 6, code: "out_of_stock", message: "none" })
            .order,
        ),
      ).toBe("unfulfilled");
    const { order } = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_answered",
      at: T0 + 1,
      available: false,
    });

    expect(outcomeFor(order)).toBe("rejected");
  });

  it(`${FAILURES[7]}: the buyer paid nothing, and a repeat that pays takes the goods`, () => {
    const row = failureRow(7);
    expect(row[1]).toMatch(
      /no goods.*`delivered_unpaid`.*pays releases.*change your payout wallet.*refused/i,
    );
    expect(row[2]).toMatch(/cannot happen.*charge comes first/i);
    expect(row[3]).toMatch(/cannot happen/i);
    const unpaid = must(reach("fulfilled"), { kind: "payment_settle_failed", at: T0 + 5 }).order;

    expect(outcomeFor(unpaid)).toBe("delivered_unpaid");
    const repeated = must(unpaid, { kind: "purchase_repeated", at: T0 + 6 });
    expect(repeated.effects.some((effect) => effect.kind === "release_goods_to_agent")).toBe(false);
    const paying = must(repeated.order, { kind: "payment_verified", at: T0 + 7 });
    const settled = must(paying.order, { kind: "payment_settled", at: T0 + 8 });
    expect(outcomeFor(settled.order)).toBe("delivered");
    expect(settled.effects).toContainEqual({ kind: "release_goods_to_agent" });
  });

  it(`${FAILURES[8]}: the word says nobody knows, before the goods and after them`, () => {
    const row = failureRow(8);
    expect(row[1]).toMatch(/`payment_unresolved`.*repeat purchase is refused/i);
    expect(row[2]).toMatch(/`payment_unresolved`.*before it reaches you.*unfulfilled.*later/i);
    expect(row[3]).toMatch(/asynchronous/i);
    expect(row[4]).toMatch(/keeps checking.*no time promised/i);
    const afterTheGoods = must(reach("fulfilled"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    }).order;
    const beforeTheGoods = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(outcomeFor(afterTheGoods)).toBe("payment_unresolved");
    expect(outcomeFor(beforeTheGoods)).toBe("payment_unresolved");

    // "and owes a refund if the charge reports in later"
    const late = must(beforeTheGoods, { kind: "payment_settled", at: T0 + 1_000_000 }).order;

    expect(outcomeFor(late)).toBe("unfulfilled");
  });
});

// --- the guard --------------------------------------------------------------
