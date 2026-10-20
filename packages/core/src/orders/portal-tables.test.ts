import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deadlines } from "./deadlines.js";
import { must, newOrder, reach, T0, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Order } from "./model.js";
import { endingReasonFor, outcomeFor } from "./outcome.js";

/**
 * The portal's tables are the contract the merchant reads, so their rows are
 * test cases of this machine. Every row below is a scenario named by its own
 * first cell, and the guard at the bottom reads the portal back and fails if
 * the rows moved.
 *
 * A scenario asserts `outcomeFor`, the word the agent is handed, against the
 * sentence the row gives him. The state, the effects and the record are pinned
 * in `machine.test.ts` and not again here, so a failure says which promise
 * broke, the portal's or the machine's. Where a row promises something no
 * outcome can express, such as which event reaches the merchant's subscription
 * or whether a repeat under the same key is safe, the scenario checks that too.
 *
 * A row is pinned by its first cell only: a row added, removed or renamed on
 * the portal fails here until somebody decides which scenario it is. The rest
 * of the row is prose, checked as the machine fact it states, so a sentence
 * reworded without changing its meaning does not fail. Where a cell lists more
 * than the scenarios here name, such as the four ways an order comes to need
 * a refund, the rest is checked in `machine.test.ts` and not in this file.
 *
 * The parser is deliberately tiny: it finds a section by its heading, takes the
 * first table in it and returns its first column, or the words in backticks of
 * one named column. "How an order can end" promises the status each situation
 * reads, and every scenario there holds the machine's word to that column.
 */

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
  return [...(cells[at] ?? "").matchAll(/`([a-z_.]+)`/g)].map((found) => found[1] ?? "");
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
  "There is none, or you refused in the synchronous mode",
  "Time ran out: the price lapsed before the payment, or no synchronous delivery arrived",
  "You left",
  "The money was charged and no delivery happened",
  "You delivered synchronously and the payment did not execute",
  "The facilitator did not say whether the money was charged",
  "The merchant closed future fulfillment",
] as const;

/** The status words the page promises for one of its endings. */
const statusOf = (ending: (typeof ENDINGS)[number]): readonly string[] =>
  wordsIn(ORDERS_PAGE, "How an order can end", ending, "`status`");

function paidParcel(): Order {
  return walk(
    newOrder("async", {
      mode: { needsConfirmation: false, settle: "on_purchase", parcel: true },
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
  it(`${ENDINGS[8]}: closure preserves payment and stops future fulfillment`, () => {
    const paid = reach("unfulfilled");
    const closed = must(paid, { kind: "close_called", at: T0 + 10 }).order;
    const unresolved = must(reach("fulfilled"), { kind: "close_called", at: T0 + 10 }).order;
    expect(statusOf(ENDINGS[8])).toStrictEqual([outcomeFor(closed), outcomeFor(unresolved)]);
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
    // Three different refusals, and the row promises the agent one word for
    // all of them. The machine keeps them apart for the merchant's own
    // metrics; this is where they are held to the single word the page gives
    // the buyer. Parameters that do not fit and a payment that fails its check
    // are refused by the gateway before the machine sees them, so they are not
    // this row's.
    //
    // The row's other half, that a merchant's own refusal reaches the agent
    // with his code and message, is held in
    // `apps/gateway/src/http/order-status.test.ts`, where the agent's answer is
    // built.
    const noStock = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_answered",
      at: T0 + 1,
      available: false,
    }).order;
    const refusedTheParams = must(reach("dispatched"), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "invalid_params",
      message: "the address does not parse",
    }).order;
    const refusedInSync = reach("failed");

    for (const order of [noStock, refusedTheParams, refusedInSync]) {
      expect(statusOf(ENDINGS[2]), `from ${order.state}`).toStrictEqual([outcomeFor(order)]);
    }
  });

  it(`${ENDINGS[3]}: the order is closed on time and nothing moved`, () => {
    const priceLapsed = must(newOrder("sync"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "quote_expiry",
    }).order;
    const noSyncGoods = must(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "sync_response",
    }).order;

    for (const order of [priceLapsed, noSyncGoods]) {
      expect(statusOf(ENDINGS[3]), `from ${order.state}`).toStrictEqual([outcomeFor(order)]);
    }
  });

  it(`${ENDINGS[4]}: what was not delivered comes back to the buyer`, () => {
    const free = must(reach("dispatched"), { kind: "merchant_departed", at: T0 + 5 }).order;
    const charged = must(paidAsync(), { kind: "merchant_departed", at: T0 + 5 }).order;

    // The money did move on the second, so the same departure has to reach
    // the agent as a different word: closing it as though nobody owed anything
    // would lose the buyer's money.
    expect(statusOf(ENDINGS[4])).toStrictEqual([outcomeFor(free), outcomeFor(charged)]);
    expect(outcomeFor(charged)).toBe("unfulfilled");
  });

  it(`${ENDINGS[5]}: the money is the merchant's and the order waits for a refund`, () => {
    expect(statusOf(ENDINGS[5])).toStrictEqual([outcomeFor(reach("unfulfilled"))]);
  });

  it(`${ENDINGS[7]}: the agent is told the outcome is unknown, not that he was refused`, () => {
    // The row promises "the outcome of the payment is not known", not
    // "refused". To an agent deciding whether to buy the same thing elsewhere
    // these are different answers, and the machine may not give the cheaper one
    // when it does not know.
    const unresolved = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(statusOf(ENDINGS[7])).toStrictEqual([outcomeFor(unresolved)]);
    expect(outcomeFor(unresolved)).not.toBe("rejected");

    // And the row's promise that a repeat with the same key is safe: it costs
    // the buyer nothing, because no second charge is sent over the first.
    const repeated = transition(unresolved, { kind: "purchase_repeated", at: T0 + 1_000_000 });

    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.effects).toStrictEqual([]);
  });

  it(`${ENDINGS[6]}: the money never came, and a repeat drives the payment home`, () => {
    const order = reach("delivered_unpaid");

    expect(statusOf(ENDINGS[6])).toStrictEqual([outcomeFor(order)]);

    const closed = walk(order, [
      { kind: "purchase_repeated", at: T0 + 6 },
      { kind: "payment_verified", at: T0 + 7 },
      { kind: "payment_settled", at: T0 + 8 },
    ]);

    expect(outcomeFor(closed)).toBe("delivered");
  });

  it(`${ENDINGS[6]}: where the charge went unanswered instead, the repeat waits`, () => {
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
    expect(statusOf(ENDINGS[7])).toStrictEqual([outcomeFor(order)]);

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
  "The price an order was given",
  "Each hand-over of an order to your process",
  "The goods of a synchronous order",
  "The facilitator's answer about the charge",
  "The delivery of an asynchronous order",
  "The shipment of a parcel",
] as const;

describe('apps/docs/orders.md, "Every time limit"', () => {
  it(`${TIME_LIMITS[0]}: a synchronous card sells at its own price, the others are refused`, () => {
    const silent = (order: Order) => must(order, { kind: "quote_silent", at: T0 + 1 }).order;
    const sync = silent(newOrder("sync", { priceCheck: "merchant" }));
    const async = silent(newOrder("async", { priceCheck: "merchant" }));
    const parcel = silent(
      newOrder("async", {
        mode: { needsConfirmation: false, settle: "on_purchase", parcel: true },
        priceCheck: "merchant",
      }),
    );

    expect(outcomeFor(sync)).toBe("in_progress");
    for (const refused of [async, parcel]) {
      expect(outcomeFor(refused)).toBe("rejected");
      expect(endingReasonFor(refused)).toBe("price_check_unanswered");
    }
  });

  it(`${TIME_LIMITS[1]}: the price stops holding and the agent asks again`, () => {
    const { order } = must(newOrder("sync"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "quote_expiry",
    });

    expect(outcomeFor(order)).toBe("expired");
    expect(endingReasonFor(order)).toBe("price_expired");
  });

  it(`${TIME_LIMITS[2]}: the order comes again rather than closing`, () => {
    // An answer that did not come back is not an answer, so the agent is not
    // told his purchase failed: it is still going, and the order goes back to
    // the merchant.
    const { order } = must(reach("dispatched"), { kind: "handler_undelivered", at: T0 + 4 });

    expect(outcomeFor(order)).toBe("in_progress");
  });

  it(`${TIME_LIMITS[3]}: nothing is charged, and late goods are not lost`, () => {
    const closed = must(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "sync_response",
    }).order;

    expect(outcomeFor(closed)).toBe("expired");
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
  });

  it(`${TIME_LIMITS[5]}: the money is already the merchant's and a refund is owed`, () => {
    const { order } = must(paidAsync(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(outcomeFor(order)).toBe("unfulfilled");
  });

  it(`${TIME_LIMITS[6]}: a parcel not shipped in time owes a refund as well`, () => {
    const { order } = must(paidParcel(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(outcomeFor(order)).toBe("unfulfilled");
  });
});

// --- apps/docs/orders.md, "Events on the same subscription" -------------------

const EVENTS = [
  "A paid order was left unfulfilled",
  "A payment did not execute after a synchronous delivery",
] as const;

/** The event the page says a situation arrives as, which the machine has to emit. */
const sentAs = (event: (typeof EVENTS)[number]) => ({
  kind: "emit_merchant_event",
  event: wordsIn(ORDERS_PAGE, "Events on the same subscription", event, "`type`")[0],
});

describe('apps/docs/orders.md, "Events on the same subscription"', () => {
  it(`${EVENTS[0]}: sent when the goods did not come in time`, () => {
    const { effects } = must(paidAsync(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(effects).toContainEqual(sentAs(EVENTS[0]));
  });

  it(`${EVENTS[0]}: sent when the merchant left with the money and the goods undelivered`, () => {
    // A departure closes the open orders, and one that took money and delivered
    // nothing leaves a debt exactly as a passed deadline does, so the merchant
    // is owed the same notice by the same event.
    const { effects } = must(paidAsync(), { kind: "merchant_departed", at: T0 + 5 });

    expect(effects).toContainEqual(sentAs(EVENTS[0]));
  });

  it(`${EVENTS[1]}: sent when the goods went out and the money did not arrive`, () => {
    const { effects } = must(reach("fulfilled"), { kind: "payment_settle_failed", at: T0 + 5 });

    expect(effects).toContainEqual(sentAs(EVENTS[1]));
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

function priceCheckedParcel(): Order {
  return newOrder("async", {
    mode: { needsConfirmation: false, settle: "on_purchase", parcel: true },
    priceCheck: "merchant",
  });
}

describe('apps/docs/failures.md, "Every failure, mode by mode"', () => {
  it(`${FAILURES[0]}: the sale goes on where the money is still ahead of it`, () => {
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
    expect(outcomeFor(afterTheCharge)).toBe("unfulfilled");
  });

  it(`${FAILURES[2]}: the order comes again rather than closing`, () => {
    // An exception is not an answer, so the agent is not told his purchase
    // failed: it is still going, and the order goes back to the merchant.
    const { order } = must(reach("dispatched"), { kind: "handler_undelivered", at: T0 + 4 });

    expect(outcomeFor(order)).toBe("in_progress");
  });

  it(`${FAILURES[3]}: silence ends the same way a refusal does, only on time`, () => {
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
    const delivered = reach("delivered");
    const { order } = must(delivered, { kind: "purchase_repeated", at: T0 + 99 });

    expect(outcomeFor(order)).toBe("delivered");
  });

  it(`${FAILURES[6]}: said in the price check, the buyer's money does not move`, () => {
    const { order } = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_answered",
      at: T0 + 1,
      available: false,
    });

    expect(outcomeFor(order)).toBe("rejected");
  });

  it(`${FAILURES[7]}: the buyer paid nothing, and a repeat that pays takes the goods`, () => {
    const unpaid = must(reach("fulfilled"), { kind: "payment_settle_failed", at: T0 + 5 }).order;

    expect(outcomeFor(unpaid)).toBe("delivered_unpaid");
  });

  it(`${FAILURES[8]}: the word says nobody knows, before the goods and after them`, () => {
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

describe("the portal and this machine cannot drift apart quietly", () => {
  it('has exactly the encoded rows in "How an order can end"', () => {
    expect(tableRows(ORDERS_PAGE, "How an order can end")).toStrictEqual([
      ...ENDINGS.slice(0, 7),
      ENDINGS[8],
      ENDINGS[7],
    ]);
  });

  it('has exactly the encoded rows in "Every time limit"', () => {
    expect(tableRows(ORDERS_PAGE, "Every time limit")).toStrictEqual([...TIME_LIMITS]);
  });

  it('has exactly the encoded rows in "Events on the same subscription"', () => {
    expect(tableRows(ORDERS_PAGE, "Events on the same subscription")).toStrictEqual([...EVENTS]);
  });

  it('has exactly the encoded rows in "Every failure, mode by mode"', () => {
    expect(tableRows(FAILURES_PAGE, "Every failure, mode by mode")).toStrictEqual([...FAILURES]);
  });
});
