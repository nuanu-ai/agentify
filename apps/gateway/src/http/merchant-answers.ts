/**
 * What a merchant's call answers with when it does not simply work, worded once
 * for the two callers that meet it.
 *
 * The route at the door writes a refusal into the contract's envelope under
 * its status (`routes.ts`). The dashboard calls the same flows inside the
 * process the two share (ADR-0030), and draws the same sentence on a page under
 * the same status. A refusal is a claim like any other, and two copies of one
 * would drift into two accounts of the same fact, so each is written here and
 * nowhere else. The two order documents a merchant reads are built here for
 * the same reason: the list leaves out what it cannot describe, and a read of
 * one order says why it cannot, and both callers have to say it alike.
 *
 * A refusal only one of the two meets stays with it: the one about the key a
 * call was made with in the routes, and a wallet change's in the dashboard,
 * which is the one place a wallet is set.
 */

import { outcomeFor } from "@agentify/core";
import type { ErrorCode, OrderList, OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import { orderDocumentOf } from "../app/runner.js";
import type { StoredOrder } from "../ports/store.js";

/**
 * The status codes.
 *
 * They are here rather than scattered through the handlers so that a reader can
 * see the whole judgement at once. Two of them are worth arguing. A merchant's
 * call that the machine could not honour comes back as 409 rather than 200:
 * the document already says `ok: false`, but a client that only reads statuses
 * would otherwise record a refusal as a success. And a purchase whose order
 * ended in anything but delivery is also 409 — the call was understood, and
 * what it ran into is the state of the world.
 */
export const OK = 200;
export const BAD_REQUEST = 400;
export const PAYMENT_REQUIRED = 402;
export const NOT_FOUND = 404;
export const CONFLICT = 409;
export const UNPROCESSABLE = 422;
/** Something of ours failed, and the call is not known to have done anything. */
export const FAILED = 500;

/** One refusal: the status it is answered under, its code and its sentence. */
export interface Refused {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  /** Fields the envelope carries beside the sentence, such as the problems. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * A card of another merchant's is refused in the words a card that is not there
 * gets. Pausing is not a way of finding out what somebody else sells.
 */
export const NO_SUCH_ITEM: Refused = {
  status: NOT_FOUND,
  code: "no_such_item",
  message: "there is no such product",
};

/**
 * A key of another merchant's is refused in the words a key that is not there
 * gets. Disabling is not a way of counting somebody else's keys.
 */
export const NO_SUCH_KEY: Refused = {
  status: NOT_FOUND,
  code: "no_such_key",
  message: "there is no such key",
};

/**
 * Another merchant's order is not found — the same answer an identifier naming
 * nothing gets, so a stranger learns nothing by guessing.
 */
export const NO_SUCH_ORDER: Refused = {
  status: NOT_FOUND,
  code: "no_such_order",
  message: "there is no such order",
};

/**
 * A defect. The merchant is told that something here is broken, and nothing
 * about what: an error text is a claim like any other, and one assembled out of
 * an exception makes claims about our internals to somebody who cannot act on
 * them.
 */
export const GATEWAY_FAILED: Refused = {
  status: FAILED,
  code: "gateway_failed",
  message: "this call did not complete and nothing was decided",
};

/**
 * A merchant who has left pressing "start selling again", in the words the
 * flow gave: leaving closed their open orders and left refunds owed, and
 * putting the word back would return them to the catalog with none of that
 * unwound.
 */
export const merchantDeparted = (why: string): Refused => ({
  status: CONFLICT,
  code: "merchant_departed",
  message: why,
});

/**
 * A body that is not what the call takes, with the reasons as the sentence
 * itself rather than behind it: a worker reporting a refused price answer
 * prints the sentence and not the list, and a page shows the sentence. The
 * door says this of a price answer whose price cannot be sold at; the
 * dashboard says it of anything it would send that its route's schema
 * refuses.
 */
export const bodyRefused = (problems: readonly { readonly message: string }[]): Refused => ({
  status: BAD_REQUEST,
  code: "malformed_body",
  message: problems.map((problem) => problem.message).join("; "),
  details: { problems },
});

/**
 * The merchant's own read of one order, or why it cannot be given.
 *
 * The shape it answers in carries a sale price, and an order that has none
 * cannot be described in it: standing the card's number in for it would be a
 * claim about a sale that was never priced. Which of the two silences it is
 * matters to the merchant, so both are said, along with where the order ended
 * — one closed before it was priced is not waiting for anything, and saying it
 * was would be a positive false statement about a purchase that is over.
 */
export function merchantOrderAnswer(
  record: StoredOrder | null,
):
  | { readonly ok: true; readonly document: OrderWithStatus }
  | { readonly ok: false; readonly refused: Refused } {
  if (record === null) {
    return { ok: false, refused: NO_SUCH_ORDER };
  }
  const status = outcomeFor(record.order);
  if (record.order.price === null) {
    const open = status === "in_progress";
    return {
      ok: false,
      refused: {
        status: CONFLICT,
        code: open ? "order_not_priced_yet" : "order_closed_before_it_was_priced",
        message: open
          ? "this order is still waiting for its price, and until it has one there is no sale to describe"
          : `this order ended as ${status} before anybody named a price for it, so there is no sale to describe`,
        details: { status },
      },
    };
  }
  return { ok: true, document: { ...orderDocumentOf(record), status } };
}

/**
 * A merchant's orders, as the list describes them.
 *
 * Worth knowing before this list is reconciled against: it cannot show an
 * order that was closed before anybody named a price for it — a product the
 * merchant said was gone, or a price check he never answered on a card whose
 * money moves at the purchase. The document every row is written in carries a
 * sale price and those orders have none. They are readable one at a time by
 * identifier, where the refusal says what became of them.
 */
export function merchantOrderList(records: readonly StoredOrder[]): OrderList {
  return {
    orders: records
      .filter((record) => record.order.price !== null)
      .map((record) => ({ ...orderDocumentOf(record), status: outcomeFor(record.order) })),
  };
}
