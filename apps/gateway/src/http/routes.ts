/**
 * The handler behind each route of the contract's table. Each translates one
 * HTTP request into one call on the gateway; the status codes are the only
 * judgement made here, because the contract carries none.
 *
 * Refusals and the payment challenge are written straight to the response;
 * everything else goes back as a document held to the route's schema on the
 * way out.
 */

import { outcomeFor } from "@agentify/core";
import type {
  IssueKeyRequest,
  OrderListQuery,
  PurchaseRequest,
  RouteName,
  Seller,
  SellerNameRequest,
  WorkerPollRequest,
} from "@nuanu-ai/agentify-contracts";
import { PurchaseRequestSchema } from "@nuanu-ai/agentify-contracts";
import type { Caller, Gateway, PurchaseAttempt } from "../app/gateway.js";
import { agentOrderStatusOf } from "../app/runner.js";
import {
  BAD_REQUEST,
  bodyRefused,
  CONFLICT,
  merchantDeparted,
  merchantOrderAnswer,
  merchantOrderList,
  NO_SUCH_ITEM,
  NO_SUCH_KEY,
  NO_SUCH_ORDER,
  OK,
  PAYMENT_REQUIRED,
  type Refused,
  UNPROCESSABLE,
} from "./merchant-answers.js";
import type { MountedRoute, RouteAnswer, RouteCall } from "./server.js";
import { hold, refusal } from "./server.js";
import {
  CHALLENGE_REASONS,
  type ChallengeReason,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PaymentEdge,
  paymentFingerprint,
  presentedPayment,
} from "./x402.js";

/**
 * The merchant whose key opened this call. The mounting loop answers 401
 * before any handler runs, so null here means the route table and this file
 * disagree about which calls are the merchant's: stop rather than act for an
 * invented merchant.
 */
function merchantOf({ merchantId }: RouteCall): string {
  if (merchantId === null) {
    throw new Error(
      "this call was served as one of the merchant's and reached its handler with no merchant behind it",
    );
  }
  return merchantId;
}

/** The key this call was made with; null is impossible for the same reason. */
function callersKey({ keyId }: RouteCall): string {
  if (keyId === null) {
    throw new Error(
      "this call was served as one of the merchant's and reached its handler with no key behind it",
    );
  }
  return keyId;
}

function keyCaller(call: RouteCall): Caller {
  return { kind: "key", keyId: callersKey(call) };
}

export function handlersFor(gateway: Gateway): Partial<Record<RouteName, MountedRoute>> {
  const { config } = gateway.runtime;
  const edge = new PaymentEdge(config);

  return {
    publish_card: {
      // Checked by the flow, so everything wrong with the card comes back as
      // the contract's list of findings.
      checksItsOwnBody: true,
      serve: async (call) => {
        const published = await gateway.publishCard(merchantOf(call), call.body);
        return { status: published.ok ? OK : UNPROCESSABLE, document: published };
      },
    },

    list_catalog: { serve: async () => ({ status: OK, document: await gateway.catalog() }) },

    list_merchant_cards: {
      serve: async (call) => ({
        status: OK,
        document: await gateway.merchantCards(merchantOf(call)),
      }),
    },

    pause_card: { serve: (call) => cardPaused(gateway, call, true) },

    resume_card: { serve: (call) => cardPaused(gateway, call, false) },

    pause_selling: { serve: (call) => sellingSet(gateway, call, "paused") },

    resume_selling: { serve: (call) => sellingSet(gateway, call, "open") },

    list_receipts: {
      serve: async (call) => ({ status: OK, document: await gateway.receipts(merchantOf(call)) }),
    },

    get_seller_name: {
      serve: async (call) => ({
        status: OK,
        document: await gateway.sellerName(merchantOf(call)),
      }),
    },

    set_seller_name: {
      serve: async (call) => ({
        status: OK,
        document: await gateway.setSellerName(merchantOf(call), call.body as SellerNameRequest),
      }),
    },

    get_payout_wallet: {
      serve: async (call) => ({
        status: OK,
        document: await gateway.payoutWallet(merchantOf(call)),
      }),
    },

    list_keys: {
      serve: async (call) => ({
        status: OK,
        document: {
          keys: await gateway.merchantKeys(merchantOf(call)),
          this_call: callersKey(call),
        },
      }),
    },

    issue_key: {
      serve: async (call) => ({
        status: OK,
        document: await gateway.issueMerchantKey(
          merchantOf(call),
          (call.body as IssueKeyRequest).label,
          keyCaller(call),
        ),
      }),
    },

    disable_key: {
      serve: async (call) => {
        const disabled = await gateway.disableMerchantKey(
          merchantOf(call),
          call.params.key_id ?? "",
          keyCaller(call),
        );

        if (disabled === "locked_out") {
          // A call may not disable the key it was made with, or the caller
          // would be left with nothing to reach the gateway.
          return written(
            call.response,
            CONFLICT,
            refusal(
              "key_opened_this_call",
              "this is the key this call was made with, and disabling it would leave the caller with nothing to reach the gateway",
            ),
          );
        }
        if (disabled === null) {
          return refusedWith(call.response, NO_SUCH_KEY);
        }
        return { status: OK, document: disabled };
      },
    },

    get_order: {
      serve: async (call) => {
        const answered = merchantOrderAnswer(
          await gateway.merchantOrder(merchantOf(call), call.params.order_id ?? ""),
        );
        return answered.ok
          ? { status: OK, document: answered.document }
          : refusedWith(call.response, answered.refused);
      },
    },

    list_orders: {
      serve: async (call) => {
        // Only "true" narrows the list; anything else asks for every order of
        // this merchant's, as the contract says.
        const asked = (call.query as OrderListQuery | undefined)?.open;
        const records = await gateway.orders(merchantOf(call), asked === "true" ? true : undefined);
        return { status: OK, document: merchantOrderList(records) };
      },
    },

    poll_worker: {
      serve: async (call) => {
        const asked = call.body as WorkerPollRequest;
        // The draw stops when the worker's connection closes before an answer;
        // otherwise the poll would take an event, which is sent once, off the
        // stream for nobody. A close between the draw and the answer still
        // loses it, which at-most-once events accept.
        const gone = new AbortController();
        call.response.once("close", () => {
          if (!call.response.writableEnded) {
            gone.abort();
          }
        });
        // A worker that left while the key and body were read has already
        // closed before the listener was attached.
        if (call.response.destroyed) {
          gone.abort();
        }
        // A merchant selling through a connected shop has their orders filled
        // by the dashboard's connector, so their own code is refused in words
        // rather than answered empty forever. A switch after this read ends the
        // poll with nothing (`sellThrough`).
        if ((await gateway.sellsThrough(merchantOf(call))) !== "api") {
          return written(call.response, CONFLICT, refusal("call_refused", SOLD_THROUGH_A_SHOP));
        }
        return {
          status: OK,
          // The stream is named by the key's merchant, so a stranger's envelope
          // is never drawn. The request's `max` is not read; the contract
          // leaves the size of the answer to the gateway.
          document: await gateway.poll(
            merchantOf(call),
            asked.wait_seconds === undefined
              ? gateway.runtime.config.worker.pollWaitMs
              : asked.wait_seconds * 1_000,
            { gone: gone.signal, keyId: callersKey(call) },
          ),
        };
      },
    },

    answer_order: {
      serve: async (call) =>
        answeredOrder(
          call.response,
          await gateway.answerOrder(
            merchantOf(call),
            call.params.order_id ?? "",
            call.body as never,
          ),
        ),
    },

    deliver_order: {
      serve: async (call) =>
        answeredOrder(
          call.response,
          await gateway.deliverOrder(
            merchantOf(call),
            call.params.order_id ?? "",
            call.body as never,
          ),
        ),
    },

    refuse_order: {
      serve: async (call) =>
        answeredOrder(
          call.response,
          await gateway.refuseOrder(
            merchantOf(call),
            call.params.order_id ?? "",
            call.body as never,
          ),
        ),
    },

    accept_order: {
      serve: async (call) =>
        answeredOrder(
          call.response,
          await gateway.acceptOrder(
            merchantOf(call),
            call.params.order_id ?? "",
            call.body as never,
          ),
        ),
    },

    answer_quote: {
      serve: async (call) => {
        const answered = await gateway.answerQuote(
          merchantOf(call),
          call.params.price_id ?? "",
          call.body as never,
        );
        if ("refused" in answered) {
          return refusedWith(call.response, bodyRefused(answered.refused));
        }
        return { status: OK, document: answered };
      },
    },

    purchase_item: {
      // An unpaid POST without the document is the probe, not a mistake, and
      // only the route can tell the two apart.
      checksItsOwnBody: true,
      serve: (call) => purchase(gateway, edge, call),
    },

    get_order_status: { serve: (call) => orderStatus(gateway, call) },
  };
}

/**
 * What became of one purchase, for the agent that made it. Knowing the order's
 * identifier stands in for a key, so the read is not scoped to a merchant. The
 * document is the same one the purchase itself answers with.
 */
async function orderStatus(
  gateway: Gateway,
  { params, response }: RouteCall,
): Promise<RouteAnswer> {
  // The answer can carry the goods, and whoever holds a copy holds them, so no
  // cache on the way may keep one. The refusal says the same, or the header
  // alone would tell an order from a guess.
  response.setHeader("Cache-Control", "no-store");
  const record = await gateway.orderById(params.order_id ?? "");
  if (record === null) {
    return refusedWith(response, NO_SUCH_ORDER);
  }

  return {
    status: OK,
    document: agentOrderStatusOf(
      record,
      await gateway.sellerOf(record.merchantId),
      gateway.runtime.config,
    ),
  };
}

/**
 * All of this merchant's selling stopped or started again, answered with their
 * whole catalog so which cards came back is stated rather than inferred. A
 * departed merchant is refused.
 */
async function sellingSet(
  gateway: Gateway,
  call: RouteCall,
  selling: "open" | "paused",
): Promise<RouteAnswer> {
  const changed = await gateway.setSelling(merchantOf(call), selling);
  if (!changed.ok) {
    return refusedWith(call.response, merchantDeparted(changed.why));
  }
  return { status: OK, document: changed.cards };
}

/**
 * One card taken off sale or put back. The call states the wanted state rather
 * than asking for a change, so pausing a paused card succeeds and a retry is
 * safe.
 */
async function cardPaused(
  gateway: Gateway,
  call: RouteCall,
  paused: boolean,
): Promise<RouteAnswer> {
  const card = await gateway.setCardPaused(merchantOf(call), call.params.item_id ?? "", paused);
  if (card === null) {
    return refusedWith(call.response, NO_SUCH_ITEM);
  }
  return { status: OK, document: card };
}

function answeredOrder(
  response: RouteCall["response"],
  answered: { readonly ok: boolean } | null,
): RouteAnswer {
  if (answered === null) {
    return refusedWith(response, NO_SUCH_ORDER);
  }
  return { status: answered.ok ? OK : CONFLICT, document: answered };
}

/**
 * The challenge and nothing else: the answer to a call that is not a purchase.
 * `why` is the challenge's error line: the reason this call did not return the
 * resource.
 */
async function probeAnswer(
  gateway: Gateway,
  edge: PaymentEdge,
  response: RouteCall["response"],
  itemId: string,
  why: ChallengeReason,
): Promise<RouteAnswer> {
  const offered = await gateway.paidResource(itemId);
  if (offered === null) {
    return refusedWith(response, NO_SUCH_ITEM);
  }
  if (offered.selling !== "open") {
    // An off-sale card answers no challenge: the challenge carries the
    // discovery declaration, and would keep inviting agents to a purchase that
    // is always refused.
    return written(
      response,
      CONFLICT,
      refusal("not_selling", "this product is not on sale at the moment"),
    );
  }
  response.setHeader(
    PAYMENT_REQUIRED_HEADER,
    edge.challengeFor(
      { amount: offered.stored.card.price.amount, currency: offered.stored.card.price.currency },
      null,
      {
        itemId: offered.stored.id,
        card: offered.stored.card,
        serviceName: offered.serviceName,
        payTo: offered.payTo,
      },
      why,
    ),
  );
  return written(response, PAYMENT_REQUIRED, {});
}

/** Whether a body was sent at all, whatever the parser made of it. */
const declaresABody = (headers: Record<string, string | string[] | undefined>): boolean =>
  headers["transfer-encoding"] !== undefined ||
  Number(
    Array.isArray(headers["content-length"])
      ? headers["content-length"][0]
      : (headers["content-length"] ?? 0),
  ) > 0;

/** An empty document, which is what a catalog validator's probe carries. */
const isEmptyDocument = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  !Array.isArray(body) &&
  Object.keys(body).length === 0;

/**
 * Buying one product.
 *
 * An unpaid GET, or an unpaid POST with no body or an empty document, is a
 * probe and gets the challenge, never a purchase: catalog validators and
 * crawlers ask for a paid resource that way, and treating the validator's
 * empty POST as a purchase keeps the product out of the catalog. Any other
 * malformed document is refused with its fields before the agent signs
 * anything.
 *
 * A POST with the purchase document and no payment opens and prices an order
 * and answers with the challenge. With a payment it drives the order whose
 * payment reference the payment carries; a payment naming no order we hold
 * by its reference gets a fresh challenge, so the agent pays against a price
 * we actually issued.
 */
async function purchase(
  gateway: Gateway,
  edge: PaymentEdge,
  { params, body, request, response }: RouteCall,
): Promise<RouteAnswer> {
  const itemId = params.item_id ?? "";
  const presented = presentedPayment(request.headers);

  if (request.method === "GET") {
    return probeAnswer(
      gateway,
      edge,
      response,
      itemId,
      // A payment on a GET is an agent that took the probe for the purchase.
      // It is told the payment was not read (not that there was none), or it
      // could not tell the bare challenge from a failed payment.
      presented === null ? CHALLENGE_REASONS.probe : CHALLENGE_REASONS.paymentOnAGet,
    );
  }

  // A non-JSON body arrives unread and looks absent, but absent is the probe;
  // a body sent and not read is a mistake and is named as one.
  if (body === undefined && declaresABody(request.headers)) {
    return written(
      response,
      BAD_REQUEST,
      refusal(
        "malformed_body",
        "this call's body was not read because its content-type is not application/json, so send it as JSON",
      ),
    );
  }

  // The probe on the purchase's own method, as a catalog validator asks.
  if (presented === null && (body === undefined || isEmptyDocument(body))) {
    return probeAnswer(gateway, edge, response, itemId, CHALLENGE_REASONS.probe);
  }

  const held = hold(PurchaseRequestSchema, body);

  if (presented !== null && presented !== "unreadable" && presented.paymentRef !== null) {
    const named = await gateway.orderForPayment(presented.paymentRef);
    if (named !== null) {
      // A paid request's body is read only for an address sent again, which
      // must be the one the order was priced for. A malformed one is refused,
      // or the payment would go through for a place the agent did not mean.
      if (!held.ok && carriesAnAddress(body)) {
        return written(
          response,
          BAD_REQUEST,
          refusal(
            "malformed_body",
            "this call's body is not the document this call takes, and the problems say which fields and why",
            { problems: held.problems },
          ),
        );
      }
      // Read before the payment: a failure after the money moved would leave a
      // paid agent with an error and no address to come back to.
      const seller = await gateway.sellerOf(named.merchantId);
      return answerPurchase(
        gateway,
        edge,
        response,
        await gateway.payPurchase(
          named.order.id,
          presented.raw,
          paymentFingerprint(presented.payload, edge.token()),
          held.ok ? (held.value as PurchaseRequest).ship_to : undefined,
        ),
        seller,
      );
    }
  }

  if (!held.ok) {
    return written(
      response,
      BAD_REQUEST,
      refusal(
        "malformed_body",
        "this call's body is not the document this call takes, and the problems say which fields and why",
        { problems: held.problems },
      ),
    );
  }

  const attempt = await gateway.beginPurchase(
    itemId,
    (held.value as PurchaseRequest).params,
    (held.value as PurchaseRequest).ship_to,
  );
  return answerPurchase(
    gateway,
    edge,
    response,
    attempt,
    // No payment on this path; where an answer carries an order's status,
    // the seller is read there.
    null,
    // Why this call did not return the resource. An unreadable payment must
    // be said, or the agent cannot tell its encoding is at fault and retries
    // the same header.
    presented === null
      ? undefined
      : presented === "unreadable"
        ? CHALLENGE_REASONS.unreadablePayment
        : CHALLENGE_REASONS.noHeldOrder,
  );
}

/** Whether a body that did not read as a purchase was trying to send an address. */
function carriesAnAddress(body: unknown): boolean {
  return typeof body === "object" && body !== null && "ship_to" in body;
}

async function answerPurchase(
  gateway: Gateway,
  edge: PaymentEdge,
  response: RouteCall["response"],
  attempt: PurchaseAttempt,
  seller: Seller | null,
  why?: ChallengeReason,
): Promise<RouteAnswer> {
  switch (attempt.step) {
    case "no_such_item":
      return refusedWith(response, NO_SUCH_ITEM);

    case "params_rejected":
      return written(
        response,
        UNPROCESSABLE,
        refusal(
          "params_do_not_fit",
          "these purchase parameters are not what this product's card asks for, and the problems say which of them and why",
          { problems: attempt.problems },
        ),
      );

    case "ship_to_rejected":
      return written(response, UNPROCESSABLE, refusal("ship_to_does_not_fit", attempt.message));

    case "ship_to_changed":
      // Decided once the payment was checked and before anything was claimed
      // or charged, so nothing was taken.
      return written(
        response,
        CONFLICT,
        refusal(
          "ship_to_changed",
          "this payment carries an address other than the one this purchase was priced for: start a new purchase for that address, which is priced for it",
        ),
      );

    case "not_selling":
      return written(response, CONFLICT, refusal("not_selling", attempt.message));

    case "payment_already_spent":
      // One authorisation may not buy two orders. The agent is pointed at the
      // other order only if it is still open; one that is over is a dead end.
      return written(
        response,
        CONFLICT,
        refusal(
          "payment_already_spent",
          attempt.collectable
            ? `this payment was already presented for order ${attempt.heldBy}, which is still open; one payment buys one order`
            : `this payment was already presented for order ${attempt.heldBy}, which is over; one payment buys one order, so this one needs a fresh payment`,
        ),
      );

    case "not_this_purchase":
      // The order already belongs to another payer. Its payment reference is
      // in every challenge for it and a listing can publish it, so holding it
      // proves nothing; the wording names no order and says nothing about how
      // far along it is.
      return written(
        response,
        CONFLICT,
        refusal("not_this_purchase", "this order already belongs to another payment"),
      );

    case "payment_not_verified":
      // Nothing was touched; the order ends on its own deadline.
      return written(
        response,
        CONFLICT,
        refusal("payment_not_verified", attempt.why, { retryable: attempt.retryable }),
      );

    case "payment_not_taken":
      // For example an order whose charge never reported back: a second charge
      // would spend the buyer's money on a guess. Whether a retry can succeed
      // is the order machine's to say, not this handler's.
      return written(
        response,
        CONFLICT,
        refusal("payment_not_taken", attempt.why, { retryable: attempt.retryable }),
      );

    case "pay": {
      const price = attempt.order.order.price;
      if (price === null) {
        throw new Error(`the order ${attempt.order.order.id} was offered for sale with no price`);
      }
      // The product is read from the order, never from the request's URL: a
      // payment may name an order made at another address, and the resource
      // the agent pays for must be the order's.
      const offered = await gateway.paidResource(attempt.order.itemId);
      if (offered === null) {
        throw new Error(
          `the order ${attempt.order.order.id} is for ${attempt.order.itemId}, which is not in the catalog`,
        );
      }
      response.setHeader(
        PAYMENT_REQUIRED_HEADER,
        edge.challengeFor(
          price,
          attempt.order.paymentRef,
          {
            itemId: offered.stored.id,
            card: offered.stored.card,
            serviceName: offered.serviceName,
            payTo: offered.payTo,
          },
          why,
        ),
      );
      return written(response, PAYMENT_REQUIRED, {});
    }

    // Both remaining steps answer with the agent's order status document; the
    // status code is 200 where the purchase is going through or delivered and
    // 409 where it is not.
    case "under_way":
      // A synchronous purchase that comes back without the goods is 409, not
      // 200: the agent's wait is over and it holds nothing, typically because
      // the charge has not reported back yet. Where the goods come later, 200
      // is honest, and `status_url` is the only place the agent learns where to
      // collect them.
      return {
        status: attempt.order.order.mode.settle === "after_fulfillment" ? CONFLICT : OK,
        document: agentOrderStatusOf(
          attempt.order,
          seller ?? (await gateway.sellerOf(attempt.order.merchantId)),
          gateway.runtime.config,
        ),
      };

    case "settled": {
      const settlement = attempt.order.settlement;
      if (settlement !== null) {
        // The payment layer's receipt, the agent's proof that money moved.
        response.setHeader(
          PAYMENT_RESPONSE_HEADER,
          edge.receiptHeader({
            success: true,
            transaction: settlement.transaction,
            network: gateway.runtime.config.payment.network as `${string}:${string}`,
          }),
        );
      }

      return {
        status: outcomeFor(attempt.order.order) === "delivered" ? OK : CONFLICT,
        document: agentOrderStatusOf(
          attempt.order,
          seller ?? (await gateway.sellerOf(attempt.order.merchantId)),
          gateway.runtime.config,
        ),
      };
    }
  }
}

function written(response: RouteCall["response"], status: number, document: unknown): RouteAnswer {
  response.status(status).json(document);
  return { written: true };
}

const SOLD_THROUGH_A_SHOP =
  "this merchant sells through the WooCommerce shop connected in the dashboard, and the shop's orders are filled there, so this code receives none; disconnecting the shop in the dashboard brings back the cards this code publishes, with selling stopped until it is started again";

function refusedWith(response: RouteCall["response"], refused: Refused): RouteAnswer {
  return written(response, refused.status, refusal(refused.code, refused.message, refused.details));
}
