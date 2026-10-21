/**
 * The refusals and order documents a merchant's call answers with, written
 * once for both callers: the HTTP routes and the dashboard, which calls the
 * same flows in-process. A refusal only one of them meets stays with it.
 */

import { outcomeFor } from "@agentify/core";
import type { ErrorCode, OrderList, OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import { merchantClosureOf, orderDocumentOf, paymentStatusOf } from "../app/runner.js";
import type { StoredOrder } from "../ports/store.js";

/**
 * The status codes. A merchant's call the order machine could not honour is
 * 409, not 200, so a client that reads only statuses does not record a
 * refusal as a success; a purchase that ended in anything but delivery is 409
 * too.
 */
export const OK = 200;
export const BAD_REQUEST = 400;
export const PAYMENT_REQUIRED = 402;
export const NOT_FOUND = 404;
export const CONFLICT = 409;
export const UNPROCESSABLE = 422;
export const TOO_MANY_REQUESTS = 429;
/** Something of ours failed, and the call is not known to have done anything. */
export const FAILED = 500;

export interface Refused {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  /** Fields the envelope carries beside the sentence, such as the problems. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Also the answer for another merchant's card, so pausing cannot reveal what
 * somebody else sells.
 */
export const NO_SUCH_ITEM: Refused = {
  status: NOT_FOUND,
  code: "no_such_item",
  message: "there is no such product",
};

/**
 * Also the answer for another merchant's order, so a stranger learns nothing
 * by guessing.
 */
export const NO_SUCH_ORDER: Refused = {
  status: NOT_FOUND,
  code: "no_such_order",
  message: "there is no such order",
};

/**
 * A defect. The merchant is told nothing about what broke: never assemble this
 * from an exception's text.
 */
export const GATEWAY_FAILED: Refused = {
  status: FAILED,
  code: "gateway_failed",
  message: "this call did not complete and nothing was decided",
};

/**
 * A departed merchant asking to sell again, refused in the flow's words:
 * leaving changed their open orders and left paid ones unfulfilled, which
 * selling again would unwind.
 */
export const merchantDeparted = (why: string): Refused => ({
  status: CONFLICT,
  code: "merchant_departed",
  message: why,
});

/**
 * A body that is not what the call takes. The reasons are joined into the
 * sentence itself, because workers and pages print the sentence, not the list.
 */
export const bodyRefused = (problems: readonly { readonly message: string }[]): Refused => ({
  status: BAD_REQUEST,
  code: "malformed_body",
  message: problems.map((problem) => problem.message).join("; "),
  details: { problems },
});

/**
 * The merchant's read of one order, or why it cannot be given. An order with
 * no price cannot be described in a document that carries one, and the card's
 * price must not stand in for it. The refusal tells "still waiting for its
 * price" apart from "closed before it was priced".
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
  return {
    ok: true,
    document: {
      ...orderDocumentOf(record),
      status,
      payment_status: paymentStatusOf(record.order),
      ...merchantClosureOf(record.order),
    },
  };
}

/**
 * A merchant's orders. The list leaves out orders that have no price (for
 * example closed before the merchant answered a price check); each is
 * readable by identifier, where the refusal says what became of it.
 */
export function merchantOrderList(records: readonly StoredOrder[]): OrderList {
  return {
    orders: records
      .filter((record) => record.order.price !== null)
      .map((record) => ({
        ...orderDocumentOf(record),
        status: outcomeFor(record.order),
        payment_status: paymentStatusOf(record.order),
        ...merchantClosureOf(record.order),
      })),
  };
}
