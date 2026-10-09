/**
 * What each call in the table actually does.
 *
 * The table says where a call lives and what shape goes each way; this says
 * which flow answers it. Nothing here decides anything about an order either —
 * every handler is a translation between one HTTP request and one call on the
 * gateway, and the status codes are the only judgement it makes, because the
 * contract deliberately carries none.
 *
 * Every refusal here is written straight to the response rather than returned
 * as a document, and so is the payment challenge, whose whole content is a
 * header. The refusals a merchant's call meets are worded in
 * `merchant-answers.ts`, because the dashboard meets them too, calling the same
 * flows inside the process (ADR-0030). Everything a call answers with when it works goes back as a document
 * and is held to the route's own schema on the way out. The purchase is not an
 * exception to that any more: what it answers a paid call with is the state of
 * the order it made, in the document the agent's own door answers with.
 */

import { outcomeFor } from "@agentify/core";
import type {
  IssueKeyRequest,
  OrderListQuery,
  PayoutWalletRequest,
  PurchaseRequest,
  RegistrationRequest,
  RouteName,
  Seller,
  SellerNameRequest,
  WorkerPollRequest,
} from "@nuanu-ai/agentify-contracts";
import { PurchaseRequestSchema } from "@nuanu-ai/agentify-contracts";
import type { Caller, Gateway, PurchaseAttempt } from "../app/gateway.js";
import { invitationAccepted } from "../app/merchants.js";
import { agentOrderStatusOf } from "../app/runner.js";
import type { KeyPurpose } from "../ports/store.js";
import {
  BAD_REQUEST,
  bodyRefused,
  CONFLICT,
  FORBIDDEN,
  KEY_MADE_FOR_A_DASHBOARD,
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
  walletChangeRefused,
} from "./merchant-answers.js";
import type { MountedRoute, RouteAnswer, RouteCall } from "./server.js";
import { hold, refusal } from "./server.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PaymentEdge,
  paymentFingerprint,
  presentedPayment,
} from "./x402.js";

/**
 * The merchant whose key opened this call.
 *
 * Every handler that asks is on a route the contract puts behind the merchant's
 * key, and the mounting loop resolves that key before any handler runs and
 * answers 401 where it resolves to nobody. So null cannot arrive here — it
 * would mean the route table and this file disagree about which calls are the
 * merchant's, and the safe thing then is to stop rather than to act for a
 * merchant this line had to invent.
 */
function merchantOf({ merchantId }: RouteCall): string {
  if (merchantId === null) {
    throw new Error(
      "this call was served as one of the merchant's and reached its handler with no merchant behind it",
    );
  }
  return merchantId;
}

/**
 * The key this call was made with, on a route behind the merchant's key.
 *
 * Null cannot arrive here for the reason it cannot arrive above — the door
 * resolves a key and a merchant together or refuses — and the routes that ask
 * are the ones about keys, where a wrong answer is the merchant locking
 * themselves out rather than a page failing to draw.
 */
function callersKey({ keyId }: RouteCall): string {
  if (keyId === null) {
    throw new Error(
      "this call was served as one of the merchant's and reached its handler with no key behind it",
    );
  }
  return keyId;
}

/**
 * What the key this call was made with was made for.
 *
 * Null cannot arrive here for the reason it cannot arrive above, and on the
 * dashboard's own two routes and the payout wallet the answer decides whether
 * the call happens at all.
 */
function callersPurpose({ keyPurpose }: RouteCall): KeyPurpose {
  if (keyPurpose === null) {
    throw new Error(
      "this call was served as one of the merchant's and reached its handler with no key behind it",
    );
  }
  return keyPurpose;
}

/** The key this call was made with, as the caller the gateway's flows take. */
function keyCaller(call: RouteCall): Caller {
  return { kind: "key", keyId: callersKey(call), purpose: callersPurpose(call) };
}

/**
 * What a call made with the wrong kind of key is answered with.
 *
 * The two dashboard calls share it, because they are refused for one reason: they
 * are how a dashboard holds and replaces its own credential, and a key of the
 * merchant's own code reaching either of them reaches the sweep — which would
 * take that credential away and leave somebody looking at a dashboard that no
 * longer opens.
 */
const notTheDashboards = (response: RouteCall["response"]): RouteAnswer =>
  written(
    response,
    FORBIDDEN,
    refusal(
      "not_a_dashboard_key",
      "this call is one a dashboard makes with a key of its own, and the key it was made with is one of the merchant's own code",
    ),
  );

/**
 * What a key of the merchant's own code is answered with at the payout wallet.
 *
 * The public door does not route a write to this path at all (ADR-0019), so
 * what meets this is something inside the stack, such as a command somebody
 * runs by hand. It stays as the gateway's own word on the rule rather than the
 * door's alone. The code is the one the calls about a dashboard's key are
 * refused under, because the fact is the same: this call is not one a key of
 * the merchant's own code makes. The words are this route's, because what the
 * caller needs is where the wallet is set and why this key cannot set it. The published list of codes does not move, and
 * no worker of the SDK calls this route (ADR-0006 §2).
 */
const walletIsSetInTheDashboard = (response: RouteCall["response"]): RouteAnswer =>
  written(
    response,
    FORBIDDEN,
    refusal(
      "not_a_dashboard_key",
      "the payout wallet is set only in the dashboard, on its Settings screen, by a person signed in to it, and the key this call was made with was made for the merchant's own code: a key of that kind operates the shop and cannot change where its money goes. Nothing was changed",
    ),
  );

export function handlersFor(gateway: Gateway): Partial<Record<RouteName, MountedRoute>> {
  const { config } = gateway.runtime;
  const edge = new PaymentEdge(config.payment, config.publicBaseUrl, config.payment.timeoutSeconds);

  return {
    publish_card: {
      // The card is checked by the flow rather than by the mounting loop, so
      // everything wrong with it comes back in the contract's own list of
      // findings — which is the whole point of that branch existing.
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

    register_merchant: {
      serve: async (call) => {
        const asked = call.body as RegistrationRequest;
        if (!invitationAccepted(config.registrationInvitation, asked.invitation)) {
          // One answer for a wrong code and for a gateway that takes no
          // registrations. Two answers would make this form a way of asking
          // which deployment is open, which is what the code in the door exists
          // to stop being findable (ADR-0014 §3). The words say what is needed
          // to get in and nothing about whether anything would.
          return written(
            call.response,
            FORBIDDEN,
            refusal(
              "not_invited",
              "registering here needs an invitation this gateway accepts, and this is not one",
            ),
          );
        }
        return { status: OK, document: await gateway.registerMerchant() };
      },
    },

    get_seller_name: {
      serve: async (call) => ({
        status: OK,
        document: await gateway.sellerName(merchantOf(call)),
      }),
    },

    set_seller_name: {
      // A name outside the catalog's rule never reaches this handler: the
      // mounting loop holds the body to the contract's own shape and answers
      // 400 with the schema's words, which name the rule and the number. That
      // is the same rule the flow below applies before it writes, and the two
      // are one schema rather than two copies of a number.
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

    set_payout_wallet: {
      // An address that is not one never reaches this handler: the mounting
      // loop holds the body to the contract's own shape and answers 400 with
      // the schema's words, which say what is wrong with the address and what
      // the two spellings of one are. That is the same rule the flow below
      // applies before it writes, and the two are one schema rather than two
      // copies of a regular expression and a hash.
      serve: async (call) => {
        const set = await gateway.setPayoutWallet(
          merchantOf(call),
          (call.body as PayoutWalletRequest).payout_wallet,
          keyCaller(call),
        );
        if (set === "not_a_dashboard_key") {
          return walletIsSetInTheDashboard(call.response);
        }
        return typeof set === "string"
          ? refusedWith(call.response, walletChangeRefused(set))
          : { status: OK, document: set };
      },
    },

    list_keys: {
      // The key that opened this call travels through rather than being looked
      // up again: the door resolved it a moment ago, and a second lookup would
      // be a second chance for the two to disagree. It is not always one of
      // the keys beside it, since a key made for a dashboard is on no list, and
      // it is answered all the same, because the field means the same thing on
      // every call: which key opened this one.
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

    issue_dashboard_key: {
      serve: async (call) => {
        const made = await gateway.issueDashboardKey(merchantOf(call), callersPurpose(call));
        return made === "not_a_dashboard_key"
          ? notTheDashboards(call.response)
          : { status: OK, document: made };
      },
    },

    forget_dashboard_key: {
      serve: async (call) => {
        // No merchant is passed and none is needed: the only key this can
        // remove is the one the call was made with, and that key already says
        // whose it is.
        const gone = await gateway.forgetDashboardKey(callersKey(call), callersPurpose(call));
        return gone === "not_a_dashboard_key"
          ? notTheDashboards(call.response)
          : { status: OK, document: gone };
      },
    },

    disable_key: {
      serve: async (call) => {
        const disabled = await gateway.disableMerchantKey(
          merchantOf(call),
          call.params.key_id ?? "",
          keyCaller(call),
        );

        if (disabled === "locked_out") {
          // A refusal that protects the caller from themselves rather than from
          // anybody else. A merchant whose dashboard holds this key and disabled
          // it would meet "the gateway will not take this key" on every page
          // afterwards, with no terminal to undo it from (ADR-0014 §5). It
          // reaches only the key on this call; the flow above says what that
          // leaves open.
          return written(
            call.response,
            CONFLICT,
            refusal(
              "key_opened_this_call",
              "this is the key this call was made with, and disabling it would leave the caller with nothing to reach the gateway",
            ),
          );
        }
        if (disabled === "made_for_a_dashboard") {
          return refusedWith(call.response, KEY_MADE_FOR_A_DASHBOARD);
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
        // Only "true" narrows the list. Anything else asks for everything, which
        // is what the contract says and what a merchant reconciling their books
        // has to be able to rely on — everything of theirs, that is: the
        // merchant is in the query and nobody else's order is read at all.
        const asked = (call.query as OrderListQuery | undefined)?.open;
        const records = await gateway.orders(merchantOf(call), asked === "true" ? true : undefined);
        return { status: OK, document: merchantOrderList(records) };
      },
    },

    poll_worker: {
      serve: async (call) => {
        const asked = call.body as WorkerPollRequest;
        return {
          status: OK,
          // A worker draws its own merchant's stream. It is not a filter over
          // what came back: the stream is named by the merchant the key
          // resolved to, so a stranger's envelope is never drawn and so never
          // held out of reach of the worker it was meant for. What it asks for
          // as `max` is not read: the contract leaves the size of the answer
          // to the gateway, and `Gateway#poll` says why it is always one.
          document: await gateway.poll(
            merchantOf(call),
            asked.wait_seconds === undefined
              ? gateway.runtime.config.worker.pollWaitMs
              : asked.wait_seconds * 1_000,
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
      // The document is held by the route, because an unpaid POST that brought
      // none — or brought something else — is not a mistake there: it is the
      // probe, and the loop cannot tell the two apart.
      checksItsOwnBody: true,
      serve: (call) => purchase(gateway, edge, call),
    },

    get_order_status: { serve: (call) => orderStatus(gateway, call) },
  };
}

/**
 * What became of one purchase, for the agent that made it.
 *
 * The one route here that is the agent's rather than the merchant's. Knowing
 * the order's identifier is what stands in for a key (ADR-0011), so nothing
 * about a merchant enters into it: the read is across the whole gateway,
 * because the caller has no merchant to be scoped to and the order belongs to
 * whichever merchant sold it.
 *
 * The answer is built by `agentOrderStatusOf`, which is also what the purchase
 * answers with — one document for one question, so an agent that bought and an
 * agent that came back later are told the same thing in the same shape.
 *
 * An identifier that names no order is answered in the words the merchant's
 * own read of a stranger's order gets — there is no such order, and nothing
 * about whether the string was ever one.
 */
async function orderStatus(
  gateway: Gateway,
  { params, response }: RouteCall,
): Promise<RouteAnswer> {
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
 * All selling stopped or started again, answered with the whole catalog —
 * because every card's word changed, and which cards actually came back is then
 * a fact rather than something the caller has to infer.
 *
 * A merchant who has left is refused. Leaving closed their open orders and left
 * refunds owed; putting the word back to "open" would return them to the
 * catalog with none of that unwound.
 */
async function sellingSet(
  gateway: Gateway,
  call: RouteCall,
  selling: "open" | "paused",
): Promise<RouteAnswer> {
  // One merchant's switch and nobody else's: stopping all selling takes this
  // merchant's cards out of the public catalog and leaves every other
  // merchant's exactly where they were.
  const changed = await gateway.setSelling(merchantOf(call), selling);
  if (!changed.ok) {
    return refusedWith(call.response, merchantDeparted(changed.why));
  }
  return { status: OK, document: changed.cards };
}

/**
 * One card taken off sale or put back, answered with where it now stands.
 *
 * Pausing a card that is already paused answers the same way as pausing one
 * that was selling, and that is deliberate: the call says what the merchant
 * wants to be true rather than asking for a change, so a retry after a dropped
 * connection is safe and needs no note kept of what was already pressed.
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

/** A merchant's call, answered with the document the machine produced. */
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
 * `why` is the error line, and it is the reason this call did not return the
 * resource (ADR-0021).
 */
async function probeAnswer(
  gateway: Gateway,
  edge: PaymentEdge,
  response: RouteCall["response"],
  itemId: string,
  why: string,
): Promise<RouteAnswer> {
  const offered = await gateway.paidResource(itemId);
  if (offered === null) {
    return refusedWith(response, NO_SUCH_ITEM);
  }
  if (offered.selling !== "open") {
    // A card that is off sale answers no challenge, and the reason is not
    // tidiness. A challenge carries the declaration a discovery catalog is
    // built from; kept up here, a paused card would go on inviting an agent
    // to pay for something every purchase of which comes back refused. The
    // word an agent gets is the same word the order machine would have given
    // it a moment later.
    //
    // What a catalog does with a resource that stops answering is its own
    // business and we have not measured it: the CDP documentation says such a
    // resource is eventually removed, and `docs/research/04-spike-bazaar-listing.md`
    // records that as read rather than as timed.
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
        payoutWallet: offered.payoutWallet,
      },
      // What every other paid resource on this shelf says here, and no more.
      // Measured 2026-09-01 across eighteen hosts in the public catalogue
      // (docs/research/25-what-the-challenge-says.md): fourteen of the
      // fifteen challenges that came back carry an error line, and thirteen
      // of those are the words below. Nobody puts anything about their
      // product in it, and nothing reads it — the catalogue's own record
      // drops the field. What used to be here explained that this price is
      // the published one and a purchase is priced when it is made; that is
      // true, has no reader in this field, and is not load-bearing, because
      // an agent signs against the requirements of the call it actually
      // makes and its own ceiling catches a difference. ADR-0021.
      //
      // Unless the GET brought a payment. A crawler never does, so a payment
      // here is an agent that took the probe for the purchase — one did, on
      // 2026-09-10, read a declaration that named GET — and it is about to
      // be answered with the same bare challenge it started from, which it
      // cannot tell from its payment having failed. The line is the reason
      // this call did not return the resource, which is what the line is for.
      // "Not read", not "carries none": the request did carry one.
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

/** A document that says nothing: what the validator's own probe carries. */
const isEmptyDocument = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  !Array.isArray(body) &&
  Object.keys(body).length === 0;

/**
 * Buying one product.
 *
 * An unpaid call that carries no document produces the challenge and never a
 * purchase: a GET, which carries no body, and a POST with nothing or with an
 * empty document. There is nothing to open an order with, and the address
 * answers such calls at all because that is how everything outside our design
 * asks for a paid resource: the validators and crawlers that list one — the
 * catalog's validator sends a POST declaring a JSON body and carrying none —
 * and the whole world built on the official x402 server, which answers an
 * unpaid call with the challenge before it reads a body. A paywall that held
 * the validator's empty document as a purchase kept every POST probe of ours
 * out of the catalog (docs/research/26-discovery-method-on-get.md). A document
 * of some other shape is not nothing: it is refused with the fields, before
 * the agent signs anything, at the same moment it would learn that its
 * parameters do not fit the card.
 *
 * A POST with the purchase document is the purchase. Without a payment it
 * opens an order, has it priced, and answers with what that order costs. With
 * one it looks up the order the payment names and drives it. A payment naming
 * an order we are not holding is answered with a fresh challenge rather than
 * an error: the agent then pays against a price this gateway actually issued,
 * which is the only kind it can check. A payment naming no order of ours and
 * carrying no document is refused for its body too: an order is about to be
 * opened for it and there is nothing to open it with.
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
      // Unless the GET brought a payment. A crawler never does, so a payment
      // here is an agent that took the probe for the purchase — one did, on
      // 2026-09-10, read a declaration that named GET — and it is about to
      // be answered with the same bare challenge it started from, which it
      // cannot tell from its payment having failed. "Not read", not "carries
      // none": the request did carry one.
      presented === null
        ? "payment required"
        : "this GET is not read for payment: the purchase is a POST with a JSON body",
    );
  }

  // The parser leaves a body under any content-type but JSON unread, and
  // unread arrives looking the same as absent. Absent is the probe; a body
  // that was sent and not read is a mistake, and the words name the mistake
  // rather than a field missing from a document that was never read.
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

  // Nothing, or an empty document, and no payment: the probe on the purchase's
  // own method, which is how the catalog's validator asks. A document of some
  // other shape is not nothing — it is a mistake, and the agent is told which
  // fields below, before it signs anything.
  if (presented === null && (body === undefined || isEmptyDocument(body))) {
    return probeAnswer(gateway, edge, response, itemId, "payment required");
  }

  const held = hold(PurchaseRequestSchema, body);

  if (presented !== null && presented !== "unreadable" && presented.orderId !== null) {
    const named = await gateway.orderById(presented.orderId);
    if (named !== null) {
      // The body of a paid request is read for one thing: an address sent
      // again, which has to be the one the order was priced for (ADR-0032).
      // One that is not even an address is refused rather than passed over,
      // or a payment would go through for a place the agent did not mean.
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
      // Who sold it, read before the payment is: the answer to a paid purchase
      // carries it, and a read that failed after the money moved would leave a
      // paid agent with an error and no address to come back to.
      const seller = await gateway.sellerOf(named.merchantId);
      return answerPurchase(
        gateway,
        edge,
        response,
        await gateway.payPurchase(
          presented.orderId,
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
    // No payment is presented on this path. An answer below can still carry
    // an order's status — an order that closed at its price question, or one
    // already under way — and then the seller is read there, with no money
    // having moved on this call.
    null,
    // Why this call did not return the resource, in the shortest words that are
    // true (ADR-0021). Three cases arrive here and they are not one: nothing was
    // presented, which needs no explaining; something was presented and could
    // not be decoded; and something decoded that named an order we are not
    // holding. The middle one used to be answered as the first — a price with no
    // word about the payment — and an agent whose encoding is what went wrong
    // could not tell that from an ordinary opening challenge, so it retried the
    // same broken header.
    presented === null
      ? undefined
      : presented === "unreadable"
        ? "the payment could not be read, so here is a fresh price"
        : "the payment did not name an order this gateway is holding, so here is a fresh price",
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
  why?: string,
): Promise<RouteAnswer> {
  switch (attempt.step) {
    case "no_such_item":
      return refusedWith(response, NO_SUCH_ITEM);

    case "params_rejected":
      // The findings are what the agent fixes, and the sentence is what tells
      // it that they are findings about its own parameters rather than about
      // the product or the payment. A refusal that carried the list alone left
      // whoever printed it an empty space where the reason belongs.
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
      // Settled before the payment was checked, so nothing was taken and the
      // payment is still the agent's to spend on the purchase it means.
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
      // The same signed payment was presented for a different order. It is not
      // a refusal of the payment — it may be perfectly good — it is a refusal to
      // spend one authorisation on two purchases. Whether the agent is sent to
      // collect that other order depends on whether there is anything there to
      // collect; a claim held by an order that is over is a dead end, and
      // saying otherwise would send the agent looking for nothing.
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
      // This order already belongs to another payment — the payment layer named
      // its payer, and it is not the one this call presented. An order's
      // identifier travels, in a challenge, on the merchant's stream, in a
      // receipt, and holding one is not the same as being the agent whose
      // purchase it is. The wording claims nothing about how far along the order
      // is, only that it is not this caller's to pay.
      return written(
        response,
        CONFLICT,
        refusal("not_this_purchase", "this order already belongs to another payment"),
      );

    case "payment_not_verified":
      // The payment layer did not vouch for this payment, so nothing was
      // touched: the order is exactly where it was and ends on its own
      // deadline. The agent is told what the layer said and, where trying again
      // could reach it, that it may.
      return written(
        response,
        CONFLICT,
        refusal("payment_not_verified", attempt.why, { retryable: attempt.retryable }),
      );

    case "payment_not_taken":
      // The machine would not take a payment on this order and said why. The
      // one way here today is an order whose charge never reported back: a
      // second one would be the buyer's money spent on a guess about the first,
      // and only the payment layer can end that. Whether it will end is the
      // machine's to say and not this table's — a hand-over refused while a
      // charge is mid-flight is one the machine takes once that charge reports,
      // and telling the caller it never would is wrong about the one case here
      // that resolves itself.
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
      // The product this order is for, read from the order and not from the
      // address the call came in on.
      //
      // Every call that reaches this line today opened its own order a moment
      // ago, against the product in the address, so the two agree — nobody has
      // been able to construct one where they do not. The reading is off the
      // order anyway, and the reason is what happens when they ever differ:
      // an order's identifier travels, in a challenge and in a receipt, so a
      // payment may name an order that was not made here, and the shape above
      // has a branch for a payment naming an order. The resource an agent is invited to pay for and
      // the resource a catalog lists are one string, and it belongs to the
      // order rather than to whoever typed the URL.
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
          attempt.order.order.id,
          {
            itemId: offered.stored.id,
            card: offered.stored.card,
            serviceName: offered.serviceName,
            payoutWallet: offered.payoutWallet,
          },
          why,
        ),
      );
      return written(response, PAYMENT_REQUIRED, {});
    }

    // Both of the remaining steps answer with where the order stands, in the
    // one document the agent's own door answers with. The status code is what
    // separates them, and the contract deliberately carries none of it: 200
    // where the purchase is going through or has ended in the goods, 409 where
    // it has not.
    case "under_way":
      // A synchronous purchase promises the agent the goods themselves inside
      // one ceiling. Coming back from that ceiling with no goods is not a
      // success, however the order is getting on internally — and the one way
      // to arrive there is the case that most needs saying: a charge that was
      // sent and never reported back. Answered 200, an agent would read "your
      // purchase is being worked on" for an order nothing is working on, while
      // holding nothing and not knowing whether it was charged.
      //
      // Where the money moved at the purchase and the goods come later, the
      // same document under a 200 is the honest answer: the order exists, it
      // is paid for, and the document names in `status_url` the address the
      // goods are collected at. It has to name it. The agent bought at an
      // address that names the product and not the order, so nothing it
      // already holds spells the door that hands the goods over.
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
        // The payment layer's own receipt, which an agent's x402 client reads
        // off the answer to its purchase. It travels in a header and is the
        // agent's proof that money moved; our own receipt is the merchant's
        // record and is read through the merchant's door.
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

/** One of the refusals worded for both callers, written into the envelope. */
function refusedWith(response: RouteCall["response"], refused: Refused): RouteAnswer {
  return written(response, refused.status, refusal(refused.code, refused.message, refused.details));
}
