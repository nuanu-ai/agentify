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
 * The refusals that only a call over the API can meet stay with the routes:
 * the ones about the key a call was made with, and the invitation at the
 * registration route.
 */

import { outcomeFor } from "@agentify/core";
import type { ErrorCode, OrderList, OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import type { WalletChangeRefusal } from "../app/gateway.js";
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
export const FORBIDDEN = 403;
export const NOT_FOUND = 404;
export const CONFLICT = 409;
export const UNPROCESSABLE = 422;
/** Something of ours failed, and the call is not known to have done anything. */
export const FAILED = 500;
/**
 * A dependency of this call did not do its part — the telling behind a wallet
 * change, which waits on the mail provider — and nothing was recorded.
 */
export const UNAVAILABLE = 503;

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
 * Their own key, and not one they made. A merchant switches off what they
 * issued; this one was made for a dashboard. Said in its own words rather than
 * as "no such key", because the caller is owed the reason and because the key
 * is theirs — there is nothing here a stranger learns.
 */
export const KEY_MADE_FOR_A_DASHBOARD: Refused = {
  status: CONFLICT,
  code: "key_made_for_a_dashboard",
  message:
    "this key was made for a dashboard to call as this merchant with, and only the keys the merchant issued for their own code are disabled here",
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
 * A price answer the door turned away, refused as a body that is not what the
 * call takes, with the reasons as the sentence itself rather than behind it: a
 * worker reporting a refused answer prints the sentence and not the list.
 */
export const quoteAnswerRefused = (problems: readonly { readonly message: string }[]): Refused => ({
  status: BAD_REQUEST,
  code: "malformed_body",
  message: problems.map((problem) => problem.message).join("; "),
  details: { problems },
});

/**
 * What a wallet change the gateway would not record is answered with.
 *
 * Three codes, and in every one nothing was written: the address paid now
 * and whatever change was already waiting are as they were (ADR-0019). They
 * are three codes rather than one because each asks something different of
 * whoever reads it. A message that could not be confirmed as sent to every
 * account may still have reached some, whether the provider refused one, the
 * telling failed part of the way or it did not finish in time, and its words
 * say so without naming a cause the gateway cannot know. The race comes in two
 * wordings, because the words say what may have reached a mailbox and the
 * code alone does not know: a change raced after its message went out has a
 * message in an inbox, where one raced before anything was announced has
 * none. A merchant who has read a message about a change must not be told
 * nothing was sent, and one who has none must not be sent looking for it.
 *
 * The codes are this call's alone and no worker of the SDK meets them, which
 * is why they joined the published list without moving the contract version
 * (ADR-0006 §2). None is retryable under the gateway's rule: each ends in a
 * call that works only once something else has changed — an account made,
 * mail back, a merchant who has read what is waiting.
 */
export function walletChangeRefused(why: WalletChangeRefusal): Refused {
  switch (why) {
    case "nobody_to_tell":
      return {
        status: CONFLICT,
        code: "wallet_change_nobody_to_tell",
        message:
          "a change of the payout wallet is told to every dashboard account that names this merchant before it is recorded, and no account names this merchant, so there is nobody to tell; nothing was changed and sales are paid where they were",
      };
    case "not_announced":
      return {
        status: UNAVAILABLE,
        code: "wallet_change_not_announced",
        message:
          "the message about this change could not be confirmed as sent to every account that names this merchant, so nothing was recorded and sales are paid where they were; an account may still have received it, and it says the change takes effect only if the dashboard's wallet screen shows it, which it does not",
      };
    case "raced":
      return {
        status: CONFLICT,
        code: "wallet_change_raced",
        message:
          "another change of this merchant's payout wallet was recorded between reading the wallet and writing this one, so this one was not recorded; read the wallet and ask again if this is still the address wanted",
      };
    case "raced_after_announcing":
      return {
        status: CONFLICT,
        code: "wallet_change_raced",
        message:
          "another change of this merchant's payout wallet was recorded while this one was being announced, so this one was not recorded; its message went out and says the change takes effect only if the dashboard's wallet screen shows it, which it does not. Read the wallet and ask again if this is still the address wanted",
      };
    default: {
      const unanswered: never = why;
      throw new Error(`there are no words for the wallet refusal ${String(unanswered)}`);
    }
  }
}

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
