/**
 * The refusals and order documents a merchant's call answers with, written
 * once for both callers: the HTTP routes and the dashboard, which calls the
 * same flows in-process. A refusal only one of them meets stays with it.
 */

import { outcomeFor } from "@agentify/core";
import type { ErrorCode, OrderList, OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import {
  merchantClosureOf,
  orderDocumentOf,
  paymentStatusOf,
  transactionFieldOf,
} from "../app/runner.js";
import type { StoredOrder } from "../ports/store.js";

/**
 * The status codes. A merchant's call the order machine could not honour is
 * 409, not 200, so a client that reads only statuses does not record a
 * refusal as a success; a purchase that ended in anything but delivery is 409
 * too.
 */
export const OK = 200;
export const BAD_REQUEST = 400;
const UNAUTHORISED = 401;
export const PAYMENT_REQUIRED = 402;
const NOT_FOUND = 404;
export const CONFLICT = 409;
export const UNPROCESSABLE = 422;
export const TOO_MANY_REQUESTS = 429;
/** Something of ours failed; the words say what is known of what the call did. */
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
 * One answer for no key, an unknown key and a revoked key, so a guesser learns
 * nothing.
 */
export const NOT_AUTHORISED: Refused = {
  status: UNAUTHORISED,
  code: "not_authorised",
  message: "this call is behind the merchant's key",
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
 * A defect in a call known to have decided nothing: a read, or a request that
 * failed before it reached a route. The caller is told nothing about what
 * broke: never assemble this from an exception's text.
 */
export const GATEWAY_FAILED: Refused = {
  status: FAILED,
  code: "gateway_failed",
  message: "this call did not complete and nothing was decided",
};

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
 * The merchant's read of one order, or why it cannot be given. Every order is
 * born priced at its verified payment; one with no price was never a sale,
 * and is read as no order at all.
 */
export function merchantOrderAnswer(
  record: StoredOrder | null,
):
  | { readonly ok: true; readonly document: OrderWithStatus }
  | { readonly ok: false; readonly refused: Refused } {
  if (record === null || record.order.price === null) {
    return { ok: false, refused: NO_SUCH_ORDER };
  }
  return { ok: true, document: merchantOrderOf(record) };
}

/** A merchant's orders, leaving out any with no price, which was never a sale. */
export function merchantOrderList(records: readonly StoredOrder[]): OrderList {
  return {
    orders: records.filter((record) => record.order.price !== null).map(merchantOrderOf),
  };
}

/** One priced order as its merchant reads it back, alone or in their list. */
const merchantOrderOf = (record: StoredOrder): OrderWithStatus => ({
  ...orderDocumentOf(record),
  status: outcomeFor(record.order),
  payment_status: paymentStatusOf(record.order),
  ...transactionFieldOf(record),
  ...merchantClosureOf(record.order),
});
