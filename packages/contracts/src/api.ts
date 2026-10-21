/**
 * The HTTP surface: which calls exist, at which addresses, with which document
 * going each way. The gateway serves these calls and the SDK makes them, and
 * both import this table, so they cannot disagree about an address or a shape.
 *
 * The table carries what both sides must agree on: the address, the method,
 * the door (`auth`) and the documents. The header a key travels in is
 * `MERCHANT_KEY_HEADER`; status codes, base addresses, timeouts and retry
 * policy are the gateway's. Every refusal, from any call, arrives in the one
 * envelope `ErrorEnvelopeSchema` describes.
 *
 * Paths are written as an express-style router writes them,
 * `/v0/orders/:order_id/deliver`, so the gateway mounts them unchanged. Fill
 * them in with `expandPath`, never by hand: an identifier may contain a slash
 * or a space ("SKU 100/1"), and unencoded it becomes a different route.
 *
 * Two ways of answering for an order are here and they differ. What a
 * merchant's handler returns (delivered, refused, taken on) goes to the answer
 * route, in every mode, sent by the SDK without being asked. `deliver` and
 * `refuse` are the asynchronous mode's explicit calls, made later by a
 * merchant who took an order on; in the synchronous mode they do not exist.
 */

import { z } from "zod";
import type { Fulfillment, PublicCard } from "./card.js";
import {
  CardSchema,
  FulfillmentSchema,
  MerchantCardSchema,
  PublicCardSchema,
  SellerSchema,
} from "./card.js";
import { MerchantClosureSchema, OrderCloseRequestSchema } from "./closure.js";
import { WorkerEnvelopeSchema } from "./envelope.js";
import { UnfulfilledReasonSchema } from "./events.js";
import { AcceptanceSchema, DeliverySchema, HandlerAnswerSchema, RefusalSchema } from "./handler.js";
import { PayoutWalletSchema, SellerNameRequestSchema, SellerNameSchema } from "./merchant.js";
import { OrderSchema } from "./order.js";
import { OrderEndingReasonSchema, OrderStatusSchema, PaymentStatusSchema } from "./order-status.js";
import { ParamNameSchema } from "./param-spec.js";
import {
  IdentifierSchema,
  OpenWordSchema,
  SalePriceSchema,
  TimestampSchema,
} from "./primitives.js";
import { QuoteResponseSchema } from "./quote.js";
import { ReceiptSchema } from "./receipt.js";
import { CallErrorSchema, OrderCallResultSchema, PublishResultSchema } from "./results.js";
import { SellingStateSchema } from "./selling.js";
import { ShipToSchema } from "./ship-to.js";
import { RecordedShipmentSchema } from "./shipment.js";

/**
 * An order together with the word for where it stands: the document of the
 * calls that read orders back. It is a different document from an order off
 * the worker stream, and `OrderSchema` refuses it.
 */
export const OrderWithStatusSchema = OrderSchema.extend({
  /** Where the order stands, in the words an agent and a merchant both read. */
  status: OrderStatusSchema,
  payment_status: PaymentStatusSchema,
  merchant_closure: MerchantClosureSchema.optional(),
});

/**
 * Every order the merchant asked for. An object rather than a bare array, so
 * that paging can be added as a field without changing the shape.
 */
export const OrderListSchema = z.strictObject({
  orders: z.array(OrderWithStatusSchema),
});

/**
 * A merchant's own catalog: their cards, and whether they are selling at all.
 * Every card of a merchant who has stopped all selling reads paused, so the
 * merchant's own word is carried beside the cards; it is the difference
 * between resuming a card and resuming the catalog.
 */
export const MerchantCardListSchema = z
  .strictObject({
    /** Whether this merchant is taking new orders at all. */
    selling: SellingStateSchema,

    cards: z.array(MerchantCardSchema),
  })
  .meta({
    description:
      "A merchant's own catalog: every card they have published, and whether they are taking new orders at all. The merchant's own selling word is here as well as on each card because the two are different facts, and neither can be worked out from the other. A card reads open only where all of it holds at once: the merchant is selling, the card is not paused in its own right, the merchant has a name for it to be sold under, on a deployment that settles on a real chain a wallet for the money to be paid into, and on the live deployment the operator's approval. So a card can read paused while this field reads open, and this field does not say which of the reasons it was. What does say is the refusal at the publish, whose findings about the merchant carry the codes no_seller_name, no_payout_wallet and no_operator_approval, and the merchant's own settings. This document does not say whether it is the whole catalog: paging is not designed, and when it is, this object grows the field that answers it.",
  });

/**
 * Every receipt this merchant has. A receipt is written as the goods of a paid
 * purchase are released: when they are delivered, or when a parcel's shipment
 * is recorded. A purchase that ended before any payment has none, none is
 * written while it is unknown whether the buyer was charged, and a paid order
 * awaiting fulfillment, or that remains unfulfilled, has none either. A late
 * facilitator confirmation or verified chain evidence can release held goods
 * and write their receipt; an unverified assertion cannot. So the list is not
 * an account of the money that came in.
 */
export const ReceiptListSchema = z
  .strictObject({
    receipts: z.array(ReceiptSchema),
  })
  .meta({
    description:
      "The receipts of one merchant. A receipt records a paid sale when its goods are released or its parcel's shipment is recorded. A purchase that ended before payment, one whose payment outcome is still unknown, and a paid order awaiting fulfillment or unfulfilled have no receipt. A late facilitator confirmation or verified chain evidence can release held goods and write their receipt; an unverified assertion cannot. A payment that completes after the merchant closed fulfillment writes no receipt either; the merchant is told by order.unfulfilled. The list is therefore not an account of all money received. This document does not say whether it is the whole list: paging is not designed, and the absence of a field about it is not a promise that there is no more.",
  });

/**
 * The query string of the order list. `open=true` narrows it to the orders a
 * restarted worker should walk; leaving it out asks for everything.
 *
 * The value is text, not a boolean, because a query string carries text, and
 * only the exact words `true` and `false` are accepted, so `open=1` is refused
 * rather than silently answered with every order.
 */
export const OrderListQuerySchema = z
  .strictObject({
    open: z.enum(["true", "false"]).optional(),
  })
  .meta({
    description:
      'Which orders to list. Written as text because a query string carries text. "true" narrows the list to the orders a restarted worker should walk: ones the merchant was handed and has not finished, an unfulfilled paid order, one delivered but never paid for, and one whose fulfillment the merchant closed before its payment completed, until the merchant closes it again. An order that was priced and never paid, and never reached the handler, is not in that narrowing. Leaving the field out asks for everything.',
  });

/**
 * What a worker asks of one poll. Neither field has a ceiling here: how long
 * the gateway holds a request and how many envelopes it returns are the
 * gateway's own limits, applied whatever is asked.
 */
export const WorkerPollRequestSchema = z
  .strictObject({
    /**
     * How long the gateway may hold the request open waiting for something to
     * arrive. Zero means a drain: answer with whatever is queued now and come
     * straight back. The SDK's worker never asks for one, not even when it
     * stops, since that would pull work into a process that is going away.
     */
    wait_seconds: z.int().min(0).optional(),

    /**
     * At most this many envelopes in the answer; at least one, since a call
     * asking for none would be indistinguishable from a quiet queue.
     */
    max: z.int().min(1).optional(),
  })
  .meta({
    description:
      "What a worker asks of one poll. Both fields may be left out, and then the gateway's own defaults apply. Neither carries a ceiling here, because a ceiling on a wait or on a batch would be a policy number and the policy is the gateway's: it answers with its own window and its own batch size whatever is asked for.",
  });

/**
 * What a poll answers with. An empty batch is the ordinary answer to a quiet
 * window, not a failure.
 *
 * The contract version rides here because this is the call every worker makes
 * first; the SDK refuses to start against a gateway speaking another version,
 * rather than failing on somebody's first order.
 */
export const WorkerPollResponseSchema = z.strictObject({
  /** The version of the contract this gateway speaks. */
  contract_version: z.string().regex(/\S/, "a gateway names the contract version it speaks"),

  envelopes: z.array(WorkerEnvelopeSchema),
});

/** The failure branch every order call shares. */
const OrderCallFailedSchema = z.strictObject({
  ok: z.literal(false),
  error: CallErrorSchema,
});

/**
 * What delivering, refusing or answering for an order comes back as: `ok`, and
 * on success a word for which success it was. A repeated delivery succeeds as
 * `already_delivered`, not `delivered`, so branch on `ok` and record the word.
 * A failure is one `error`; findings about the body sent ride inside it under
 * `problems`.
 */
export const OrderCallResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: OrderCallResultSchema }),
  OrderCallFailedSchema,
]);

/**
 * Closing fulfillment succeeds identically on a retry, and the first closure
 * stays recorded unless a payment completed after it.
 */
export const OrderCloseResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  OrderCallFailedSchema,
]);

/**
 * Taking an order on succeeds with no word, including a repeat after delivery.
 * Failures use the same error shape as the other order calls.
 */
export const OrderAcceptResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  OrderCallFailedSchema,
]);

/**
 * What answering a price question comes back as: whether the answer arrived in
 * time to price the purchase. `used: false` also covers a question the gateway
 * no longer holds, such as one replayed after a worker restart; in both cases
 * stock held against it can be released.
 */
export const QuoteAnswerAckSchema = z
  .strictObject({
    used: z.boolean(),
  })
  .meta({
    description:
      "Whether the merchant's answer arrived in time to price the purchase it was asked for. False also covers a question we no longer hold — a worker replaying an old envelope after a restart — because in both cases the answer priced nothing and stock held against it can be released.",
  });

/**
 * What an agent sends to buy. The parameters are always present, empty for a
 * product that needs no input. Whether the values fit the card is checked
 * against that card's declaration at the moment of purchase.
 */
export const PurchaseRequestSchema = z
  .strictObject({
    // The same key is dropped as everywhere this contract parses free-form
    // names; see `PROTOTYPE_KEY_IS_DROPPED` in `param-spec.ts`.
    params: z.record(ParamNameSchema, z.unknown()),

    /**
     * Where a parcel goes. Required on the purchase of a card whose
     * fulfillment is "ship" and refused on any other, so a buyer's address is
     * never handed over for nothing. Sent again with the payment it must be
     * the address that was priced, or be left out.
     */
    ship_to: ShipToSchema.optional(),
  })
  .meta({
    description:
      "What an agent supplies to buy: the purchase parameters, empty for a product that needs none, and for a parcel the address it goes to. The names are held to the shape a card could have declared and no further — that these values fit this card is checked against that card at the moment of purchase. ship_to is required when the card's fulfillment is \"ship\" and refused on any other card. The merchant's price question receives only its locality; the merchant receives the whole address once the order is paid. A payment is answered only at the purchase it was made for: sent with it, the product's address and params must be the ones that were priced, and ship_to the same address or left out, in which case the payment is for the address that was priced. A payment that is accepted, by the payment layer or, for an order already paid, by this gateway, that comes with another address is refused as ship_to_changed, and one that comes at another product's address or with other params as payment_not_taken; neither refusal claims or charges anything for the request it answers, its words name no order, and a different request is a new purchase. A payment that is not verified is refused as payment_not_verified before either comparison, so its words name no order and do not depend on the product address or params it came with; a body that is not the document this call takes, and a ship_to sent for a product that is not a parcel, are refused before the payment is checked. Its words name no order: that this payment charged nothing, what to do next, the reason it was refused in the words of whoever refused it, this gateway or the payment layer, and that a fresh payment for the same payment request from the wallet that signed it returns a purchase already paid for without a second charge. Whoever holds an order's payment reference, which a listing can publish, can learn from these answers whether the order was paid, since on a paid order a well-signed payment from any other wallet is refused as not_this_purchase; they cannot learn the order's identifier, its goods or its address. A payment for an order that is over is answered, before it is checked, with how that order ended. That holds while Agentify still holds the address: once it has let go of it — the order taken on, ended, or unfulfilled without being taken on — there is nothing to compare with, a payment's ship_to is checked for its shape only, and the answer is the order as it stands.",
  });

// A shipment's expected window as an agent reads it, open to fields added
// later. Opening it makes a new schema without the old one's description, so
// the description is carried across.
const closedWindow = RecordedShipmentSchema.shape.estimated_delivery.unwrap();
const openWindow = closedWindow.loose().meta(closedWindow.meta() ?? {});

/**
 * What became of a purchase, told to the agent that made it: the answer to
 * the purchase itself and to every later read of the order.
 *
 * It carries what the buyer may know and nothing more: no merchant account, no
 * merchant's key for the product, none of the parameters the buyer sent.
 * Anyone holding an order's identifier, or the `status_url` built from it, can
 * read it and the goods in it, so neither is to be shared.
 *
 * `price` and `delivered` are required and nullable, so that "none yet" is a
 * stated fact rather than a missing field. `refusal` is present only where a
 * merchant's refusal ended the order. `reason` is present where Agentify ended
 * it and the status word alone would not say what to do next, on every paid
 * order left unfulfilled, to say why nothing was delivered, on every paid
 * order whose merchant closed fulfillment, to say what Agentify knows beside
 * the merchant's own words, and on every `delivered_unpaid` order, to say that
 * the goods are held because the charge did not go through.
 */
export const AgentOrderStatusSchema = z
  .looseObject({
    order_id: IdentifierSchema,

    /**
     * Where this order is read again: the whole address of its status route,
     * scheme and host included, ready to call. An agent that bought goods that
     * come later collects them here, and cannot work the address out from the
     * purchase address.
     *
     * It is built from the address the gateway is configured to answer as,
     * never from the request, which behind a TLS-ending proxy says plain http.
     * Plain http is accepted for a gateway on a developer's machine. The scheme
     * is checked by a case-sensitive pattern rather than zod's protocol option,
     * because only a pattern survives into the JSON Schema export.
     */
    status_url: z
      .url()
      .regex(
        /^https?:\/\//,
        "an order's status address is a whole http or https address, not a path",
      ),

    /**
     * Where the order stands. Words may be added later, so a word an agent
     * does not know is not an ending it knows: ask again later rather than buy
     * again. Two branches, so the known words still cross into the export.
     */
    status: z.union([OrderStatusSchema, OpenWordSchema]),

    /**
     * The original payment's outcome, independent of fulfillment and of
     * anything the merchant says. Words may be added later, so a word an agent
     * does not know says nothing about the money: read the order again rather
     * than pay again.
     */
    payment_status: z.union([PaymentStatusSchema, OpenWordSchema]),

    /**
     * The transaction that paid this order, as the merchant's receipt names
     * it: the buyer's payment as reported by the facilitator or verified from
     * chain evidence, on the chain of this deployment, which on an EVM chain is
     * the hash of the transaction that paid the merchant's payout contract.
     * Present once payment_status is paid and a transaction was recorded,
     * whether or not the goods have reached the buyer; absent before that, and
     * on a payment that is not_paid or unresolved.
     */
    transaction: z.string().regex(/\S/, "a transaction names the transfer").optional(),

    /** The authenticated merchant's closure action; the message is their statement alone. */
    merchant_closure: MerchantClosureSchema.loose().optional(),

    /**
     * The price this order was priced at, or null where nobody ever named one.
     * It is the order's own price, not the card's: a card with a price check
     * is priced at what the check answered. "Priced at", not "sold for": an
     * order that ended without a sale still carries the number the buyer was
     * asked for, and whether money moved is the status's to say.
     */
    price: SalePriceSchema.loose().nullable(),

    /**
     * The goods once they are the buyer's, as the merchant wrote them, and
     * null until then. A synchronous delivery whose charge did not go through
     * leaves goods on an unpaid order; they stay null here until a repeat
     * purchase carries the payment.
     */
    delivered: DeliverySchema.nullable(),

    /**
     * A parcel's shipment once its merchant has recorded it, and null until
     * then; present on a parcel's order only. It sits beside `delivered`,
     * which stays null on a parcel, because a parcel handed to a carrier is
     * not goods in hand. It is the last thing Agentify knows about the parcel.
     */
    shipment: RecordedShipmentSchema.extend({ estimated_delivery: openWindow.optional() })
      .loose()
      .nullable()
      .optional(),

    /**
     * When a parcel has to be with its carrier by: the card's time to ship
     * counted from the charge, and null until the order is paid; present on a
     * parcel's order only. A parcel not shipped by then leaves its merchant
     * unfulfilled, which this document then says.
     */
    ship_by: TimestampSchema.nullable().optional(),

    /**
     * Whether this was a test purchase. A sandbox settles against nothing and
     * every other field reads as it would after a real charge, so without this
     * the document could be mistaken for proof that money moved.
     */
    test: z.boolean(),

    /**
     * Why the merchant would not sell, where a merchant's refusal closed this
     * order: their own code and sentence, word for word, in the shape a
     * handler answers in. The code may be one of the recommended codes or a
     * word of the merchant's own, so an unfamiliar one falls through to the
     * sentence. Absent means no merchant refused, never that a refusal was
     * dropped.
     */
    refusal: RefusalSchema.loose().optional(),

    /**
     * Agentify's explanation in its own words: why a rejected or expired order
     * ended, why a paid order has no delivery, what Agentify knows of a paid
     * order whose merchant closed fulfillment, and why goods made for a
     * delivered_unpaid order are held. The merchant's own words
     * stay apart, under refusal and merchant_closure.
     */
    reason: z
      .looseObject({
        code: z.union([OrderEndingReasonSchema, UnfulfilledReasonSchema, OpenWordSchema]),
        message: z.string().regex(/\S/, "a reason carries a sentence a reader can act on"),
      })
      .optional(),

    /**
     * Who sold it: the name and site the merchant gave, as their merchant
     * stands now. An agent with a question the order cannot answer, such as a
     * parcel that did not arrive, learns here where to take it.
     */
    seller: SellerSchema.loose(),
  })
  .meta({
    description:
      "What became of one purchase, as the agent that made it reads it: where the order stands, what happened to the buyer's payment, what it was priced at, and the goods once they are the buyer's. status_url is where this document is read again: the whole address of the order's status route, built from the address the gateway is configured to answer as and never from the request, and the place an agent that bought goods that come later collects them. order_id and status_url are the only key to this order and its goods. Anyone who holds either can read them, so they are not to be shared, and every answer of the status route tells caches to keep nothing. The document is smaller than the merchant's own view of the same order on purpose: no merchant account, no merchant's key for the product, none of the purchase parameters and nothing about any other order. status says where the order stands. payment_status says, independently of it, whether the original payment is paid, not_paid or unresolved; a word not among those is one added later and says nothing an agent can act on. Nothing a merchant says changes that payment fact, and closing fulfillment establishes no refund. price is what the buyer was asked for and not proof that anything was charged, or null where nobody named one. transaction is the proof: once payment_status is paid it names the transaction that paid the order, as the merchant's receipt does, whether or not the goods have come, and it is absent before that and on a payment that is not_paid or unresolved. delivered holds the goods once they are the buyer's and is null until then; goods made for a purchase whose payment failed or went unanswered are withheld rather than described. A parcel's order carries shipment instead, the merchant's record of handing it to a carrier, and ship_by, the instant it has to be with a carrier by; both are null until there is something to say, delivered stays null, and shipped is the last word Agentify has about the parcel. refusal is present only where a merchant refused: their own code and sentence, carried across unchanged. An absent refusal means there is no refusal to quote, never that one was dropped. reason is Agentify's own voice. It says why Agentify ended a rejected or expired order where the status word alone would blur what to do next, why a paid order is unfulfilled (the merchant refused it, its delivery deadline passed, or the merchant left), on a paid order whose merchant closed fulfillment, what Agentify knows beside the merchant's words, which can say otherwise, and, on delivered_unpaid, that the merchant made the goods but the charge did not go through, so nothing was taken, Agentify holds the goods, and a payment for this same purchase from the wallet that signed it releases them. unfulfilled is a paid purchase with no delivery, and late goods can still arrive until the merchant closes fulfillment. fulfillment_closed means the merchant stopped fulfillment through Agentify; merchant_closure holds when they did and their optional message, which is their statement alone and not a refund or agreement Agentify has verified. test marks a rehearsal purchase, whose other fields read as they would after a real charge. seller is who sold it, the name and shop site the merchant gave, which Agentify did not check, and the site is where to take what this document cannot answer. A status word a reader does not know is not an ending it knows: it reads the order again later and does not buy again. This document and every part inside it may gain fields, and a reader ignores the ones it does not know.",
  });

/**
 * The catalog as an agent reads it. It makes no claim to be complete: the
 * absence of a paging field is not a promise that there is nothing more.
 *
 * Items are held as whatever they are, and `cardsOf` reads each on its own,
 * so a card of a mode or shape added later leaves every other card readable.
 */
export const CatalogPageSchema = z
  .looseObject({
    items: z.array(
      z.unknown().meta({
        description:
          "One product, read on its own as a public_card. An item a reader cannot read as one is passed over, and the rest of the page stands.",
      }),
    ),
  })
  .meta({
    description:
      "Products offered for sale, as an agent reads them. This document does not say whether it is the whole catalog: paging is not designed, and when it is, this object grows the field that answers it. Until then the absence of such a field is not a promise that there is no more. Each item is read on its own as a public_card, and one a reader cannot read — a mode or a shape added after the contract it holds — is passed over while the rest of the page stands. This document may also gain fields; a reader ignores the ones it does not know.",
  });

/**
 * The cards of a catalog page that a reader of this contract can buy from,
 * each read on its own. An item that is not a card, or a card sold in a mode
 * this contract does not name, is passed over and the rest of the page
 * stands: its reader cannot know when the goods arrive or when the money
 * moves.
 */
export const cardsOf = (
  page: CatalogPage,
): (PublicCard & { readonly fulfillment: Fulfillment })[] =>
  page.items.flatMap((item) => {
    const read = PublicCardSchema.safeParse(item);
    if (!read.success) return [];
    const mode = FulfillmentSchema.safeParse(read.data.fulfillment);
    return mode.success ? [{ ...read.data, fulfillment: mode.data }] : [];
  });

/** The methods this surface uses. */
export const HTTP_METHODS = Object.freeze(["GET", "POST"] as const);

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Which door a call is behind.
 *
 * `merchant_key`: a key the merchant holds, sent as a bearer token; the call
 * acts on that merchant's cards, orders and receipts and nobody else's.
 * `none`: anybody may call, as for the catalog and the purchase, where the
 * payment stands in for authorisation.
 *
 * `order_id`: knowing an order's identifier stands in for a key. That rests on
 * the identifier being random and long enough not to be guessed, and on its
 * going only to the agent that bought and to the merchant: the payment
 * challenge, which reaches the payment facilitator and which a discovery
 * listing can publish, names the order by a separate payment reference that
 * no route but the purchase reads. Anyone else who obtains the identifier can
 * read that order, so the agent is told to keep it to itself, the document
 * behind this door carries only what the buyer may know, and a gateway must
 * answer an identifier that names no order exactly as any other unknown one.
 *
 * `undecided`: no door has been chosen. A gateway must not mount such a route;
 * see `mountableRoutes`.
 */
export const AUTH_MODES = Object.freeze(["merchant_key", "none", "order_id", "undecided"] as const);

export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * The header the merchant's key travels in, `authorization`, with the scheme
 * `Bearer`. It lives here with the helpers below so that the gateway and the
 * SDK use the same strings.
 */
export const MERCHANT_KEY_HEADER = "authorization";

const MERCHANT_KEY_SCHEME = "Bearer";

/** The value of the {@link MERCHANT_KEY_HEADER} header for a given key. */
export const merchantKeyHeaderValue = (key: string): string => `${MERCHANT_KEY_SCHEME} ${key}`;

// An auth scheme is case-insensitive (RFC 7235 §2.1), so a client that wrote
// "bearer" holds a key that is correct.
const MERCHANT_KEY_PATTERN = new RegExp(`^${MERCHANT_KEY_SCHEME}[ \\t]+(\\S+)$`, "i");

/**
 * The key inside a merchant-key header value, or null where there is not one:
 * no header, another scheme, or the scheme with nothing after it. The caller
 * never gets a half-parsed string that a constant-time comparison would match
 * against a prefix of the real key.
 */
export const merchantKeyFrom = (headerValue: string | undefined): string | null => {
  if (headerValue === undefined) {
    return null;
  }
  const match = MERCHANT_KEY_PATTERN.exec(headerValue.trim());
  return match?.[1] ?? null;
};

/**
 * How every call on this surface says no: `{ "error": { code, message,
 * retryable } }`, whatever the route and the HTTP status.
 *
 * All three fields are required; the sentence is for the person who has to do
 * something about it. Inside `error` the shape is open, and some refusals say
 * more, such as which fields did not fit. The outer object is closed, so
 * `{ "error": … }` and nothing else marks a refusal. The set of codes is open:
 * switch over `ERROR_CODES` and keep a default arm that shows the message.
 */
export const ErrorEnvelopeSchema = z
  .strictObject({
    error: z.looseObject({
      /** The name of the refusal, for the code that branches on it. */
      code: z.string().regex(/\S/, "a refusal carries a code"),

      /** The same refusal in words, for whoever has to do something about it. */
      message: z.string().regex(/\S/, "a refusal carries an explanation a person can read"),

      /**
       * Whether making this same call again could succeed. A fact about this
       * refusal, not an instruction: how long to wait and how often are the
       * caller's. It is true only where repeating the call is genuinely the way
       * through; anything definitive or arguable is false.
       */
      retryable: z.boolean(),
    }),
  })
  .meta({
    description:
      'How every call on this surface says no. One shape for every refusal of every route, whatever it is about and whatever HTTP status it arrives under: an object whose only field is "error", carrying a machine-readable code, a sentence a person can act on, and "retryable". All three are always present — a refusal with a code and no words is one only its author can read, and one that will not say whether calling again could work leaves the caller to guess between a retry loop against a door that never opens and an abandoned call that would have gone through. "retryable" is a fact about this refusal and not an instruction: it answers "could this same call succeed if it were made again", and how long to wait, how often, and whether to bother at all stay with the caller, who is the one who knows what the call was worth. This gateway assigns it conservatively — true only where repeating the very same call is genuinely the way through, such as a call that fell over before anything was decided or an answer that is not ready yet; everything definitive, and everything arguable, is false. The code is an open set here on purpose: a gateway meets situations this contract has not named, and what this schema promises is the shape rather than the vocabulary, so an unfamiliar code parses and stays readable. The codes this gateway sends today are published beside it as a list, to switch over rather than to validate against — a consumer covers those and keeps a default arm for the one it has never seen, where the sentence in this envelope is what it shows. Inside "error" a refusal may carry more about itself — where an order ended, which fields of a document did not fit — and a reader that does not recognise those must still be able to read the three that are always there. Nothing rides beside the envelope: a body carrying anything at the top level other than "error" is not a refusal, and reading one as a refusal would turn a document that merely mentions an error into a call that failed.',
  });

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/**
 * Every code the gateway refuses a call with today, for `error.code`. Not to
 * be confused with `RefusalCode`, a merchant's reason for not delivering one
 * order.
 *
 * Switch over this list, but do not validate against it: the wire is open, so
 * a newer gateway or something in front of one can answer with a code that is
 * not here. Keep a default arm for an unknown code and show its `message`; an
 * unknown code is still a readable refusal.
 */
export const ERROR_CODES = Object.freeze([
  "body_too_large",
  "body_undecodable",
  "call_refused",
  "charset_unsupported",
  "encoding_unsupported",
  "gateway_failed",
  "malformed_body",
  "malformed_query",
  "merchant_departed",
  "no_such_item",
  "no_such_order",
  "no_such_route",
  "not_authorised",
  "not_selling",
  "not_this_purchase",
  "order_closed_before_it_was_priced",
  "order_not_priced_yet",
  "params_do_not_fit",
  "payment_already_spent",
  "payment_not_taken",
  "payment_not_verified",
  "seller_busy",
  "seller_not_taking_orders",
  "ship_to_changed",
  "ship_to_does_not_fit",
] as const);

/** One of the codes this gateway is known to refuse a call with. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * What a call answers with when it works: one document per route. How a call
 * says no is {@link ErrorEnvelopeSchema}, the same for all of them.
 */
export interface RouteResponse {
  readonly document: z.ZodType;
}

export interface RouteDefinition {
  /** The method the call is made with, and the only one that carries the body. */
  readonly method: HttpMethod;
  /** The address, with path parameters written the way a router writes them. */
  readonly path: string;
  readonly auth: AuthMode;
  /** What the call is for, and anything about it the shapes cannot carry. */
  readonly description: string;
  /** What the query string may carry, where a call takes one. */
  readonly query?: z.ZodType;
  /** The body, where a call has one. */
  readonly request?: z.ZodType;
  readonly response: RouteResponse;
  /**
   * Other methods this address also answers on, without a body. The purchase
   * route answers GET too, because validators and crawlers that list a paid
   * resource ask with GET, and a paywall bound to one method hides it from
   * them.
   */
  readonly also_answers_on?: readonly HttpMethod[];
}

/**
 * Every call of the surface, under the name it is known by in both programs.
 * A test holds that no two routes share an address and a method, and that
 * every schema named here is published in the contract registry.
 *
 * `/v0` is the merchant's API, versioned so that integration code keeps
 * working while shapes change. `/x402` is the storefront, with no version in
 * the path: discovery catalogs key listings on these addresses and agents
 * build them from a base and an identifier, so the protocol is versioned
 * inside the payment challenge instead.
 *
 * Which door a call is behind is `auth`, never the prefix, even where the two
 * happen to agree.
 */
export const API_ROUTES = Object.freeze({
  publish_card: {
    method: "POST",
    path: "/v0/catalog/publish",
    auth: "merchant_key",
    description:
      "Publishes one product, or says what is wrong with the card. Republishing under the same merchant_item_id is how a card is changed rather than how a second one appears. The catalog identifier comes back beside ok, and from then on it is what an agent, a purchase and a receipt all use. A card that is not published comes back as ok:false under the code card_rejected, never retryable, with every finding named in the error's problems. Three findings this can come back with are not about the card at all. A merchant who has not set the name their products are sold under gets no_seller_name, and the way past it is POST /v0/seller-name: a card published without one reaches a buyer's agent inside a payment request that names no seller. On a deployment that settles on a real chain, a merchant who has set no wallet gets no_payout_wallet, and the way past it is the Settings screen of the merchant's dashboard, where a person signed in sets one: buyers pay into a payout contract made for that wallet, which sends the merchant's share there, so without a wallet there is no payout contract and nowhere for the money from that card's sales to go. On the live deployment, a merchant the operator has not admitted, or no longer admits, gets no_operator_approval. That decision has no merchant API: test publication remains available, while live publication remains closed until the operator grants it. Every applicable finding comes back in the same problems list as whatever is wrong with the card, so one answer carries everything standing between this card and the catalog.",
    request: CardSchema,
    response: { document: PublishResultSchema },
  },

  list_merchant_cards: {
    method: "GET",
    path: "/v0/cards",
    auth: "merchant_key",
    description:
      "The cards published under the key this call was made with, each whole and with the word it is selling under, together with whether the merchant is taking new orders at all. It is the catalog of the one merchant that key belongs to and of nobody else. It is not the public catalog: that one is unscoped, spans every merchant, carries our identifier in place of the merchant's key, and leaves out a card that is off sale — which is the one card a merchant goes looking for when they want it back on sale.",
    response: { document: MerchantCardListSchema },
  },

  pause_card: {
    method: "POST",
    path: "/v0/cards/:item_id/pause",
    auth: "merchant_key",
    description:
      "Takes one card off sale. No new order is taken for it, and the orders already accepted for it play out in the ordinary way — a pause closes nothing. Calling it on a card that is already paused changes nothing and answers the same way, so a retry after a dropped connection is safe. Republishing a paused card changes the card and leaves it paused: a merchant editing a price is not asking for it to go back on sale.",
    response: { document: MerchantCardSchema },
  },

  resume_card: {
    method: "POST",
    path: "/v0/cards/:item_id/resume",
    auth: "merchant_key",
    description:
      "Puts one card back on sale. Where the merchant has stopped all selling this lifts only this card's own pause, and the card goes on refusing new orders until selling is resumed — the answer says so in both of its words, and that is the case a merchant is most likely to misread.",
    response: { document: MerchantCardSchema },
  },

  pause_selling: {
    method: "POST",
    path: "/v0/selling/pause",
    auth: "merchant_key",
    description:
      "Stops all selling for this merchant. No new order is taken for any card, and the orders already accepted play out in the ordinary way — this is a pause and not a departure, so nothing open is closed and this call creates no fulfillment failure. The answer is the whole catalog, because every card's word changed. A merchant who has already left is refused rather than paused: their orders are closed and their unfulfilled paid orders remain recorded, and a pause would describe none of that.",
    response: { document: MerchantCardListSchema },
  },

  resume_selling: {
    method: "POST",
    path: "/v0/selling/resume",
    auth: "merchant_key",
    description:
      "Starts selling again. Cards paused in their own right stay paused: stopping all selling did not forget which they were, and putting them all back on sale would sell products their merchant took off. The answer is the whole catalog, so which cards actually came back is a fact rather than an inference. A merchant who has left is refused: leaving closed the orders that were open and left paid orders unfulfilled, and this switch unwinds none of it, so a departure is not undone here.",
    response: { document: MerchantCardListSchema },
  },

  get_seller_name: {
    method: "GET",
    path: "/v0/seller-name",
    auth: "merchant_key",
    description:
      "What the merchant this call's own key belongs to is listed under: the name a discovery catalog shows beside their products and a buyer's agent is shown beside the price. Null is the ordinary answer for a merchant who has not chosen one, and it is an answer rather than a refusal — a merchant with no name exists and has a settings screen to draw. This is not read off a card: the name belongs to the merchant, so every card of theirs carries the same one and none of them carries it.",
    response: { document: SellerNameSchema },
  },

  set_seller_name: {
    method: "POST",
    path: "/v0/seller-name",
    auth: "merchant_key",
    description:
      "Sets what the merchant this call's own key belongs to is listed under. The answer is the name as it now stands, read back from what was written rather than echoed, so a screen showing it afterwards is showing what is true. Setting the same name twice changes nothing and answers the same way, so a retry after a dropped connection is safe. A name outside the rule of the catalog that will carry it is refused and nothing is written, which leaves the merchant listed under whatever they had before. What this call will not do is take a name away: it goes from no name to a name and from one name to another, and null is refused, because without a name there is nobody for a payment request to name as the seller and every card the merchant has published would quietly come off sale — ending the selling under the name of editing a setting; somebody reaching for that wants either a different name, which is this same call, or an end to selling, which is the pause, and the pause leaves their cards where they can put them back on sale. One more thing is worth knowing before a screen is built on this: the name here is not the name a person reads in a list of merchants at a terminal. Those are two fields, held to two different rules, and only this one ever leaves us.",
    request: SellerNameRequestSchema,
    response: { document: SellerNameSchema },
  },

  get_payout_wallet: {
    method: "GET",
    path: "/v0/payout-wallet",
    auth: "merchant_key",
    description:
      "The wallet where the merchant this call's own key belongs to receives their share of sales now, and any change of it that is waiting. A buyer's agent does not pay this wallet. It pays the merchant's payout contract for it, a split contract of the 0xSplits protocol with no owner, which keeps what it is paid until somebody sends a payout, as anybody may at any time, the merchant included, and then sends 99.9% of the accumulated balance to this wallet and 0.1% to Agentify: each share is rounded down to the smallest unit of USDC, and one unit stays behind on the payout contract and on each balance a payout credits, so 1.000000 USDC paid into a new payout contract reaches this wallet as 0.998998 at its first payout, and what the rounding leaves over is divided in a later one. Nobody, Agentify included, can change those recipients or shares, and no balance of the merchant's is ever held on Agentify's side, which is why the wallet has to be theirs and why this call exists. Circle, which issues USDC, can freeze USDC at any address, the payout contract and the shared warehouse it pays through included. The payout contract is not named in this answer, and the payTo of a payment request is never the address here: the wallet receives one transfer per payout from the 0xSplits warehouse, the shared contract a payout contract pays its shares through, covering what was paid in since the payout before as that rounding leaves it, and never a buyer's own transfer. Any key of the merchant's reads it; none sets it. A person signed in to the merchant's dashboard sets it on its Settings screen. On the live deployment a first address applies at once and is announced afterwards, and a replacement is told to every account of the merchant first and waits. Null is the ordinary answer for a merchant who has set none, and it is an answer rather than a refusal — a merchant with no wallet exists and has a settings screen to draw. The address comes back in the mixed-case spelling a wallet shows, whichever of the two accepted spellings was sent to set it, so a screen showing it shows what the merchant copied out of their wallet character for character. On the live deployment a replacement for an address already set takes effect forty-eight hours after it was announced to the merchant, and until then this answers with the wallet still in force and names the waiting one, with the moment it takes effect, under pending. Null there means nothing is waiting, which is always the answer on the test channel and in a sandbox.",
    response: { document: PayoutWalletSchema },
  },

  get_order: {
    method: "GET",
    path: "/v0/orders/:order_id",
    auth: "merchant_key",
    description:
      "One order and the state it is in. Reading state back is not a convenience: a worker that restarted has to be able to find out what it still owes without resting on its own database alone.",
    response: { document: OrderWithStatusSchema },
  },

  list_orders: {
    method: "GET",
    path: "/v0/orders",
    auth: "merchant_key",
    description:
      "Orders and the states they are in. With open=true, only the ones a restarted worker should walk — ones the merchant was handed and has not finished, which includes the three that stay on it after the purchase itself is over: an unfulfilled paid order, one delivered but never paid for, and one whose payment completed after the merchant closed fulfillment, which stays until the merchant closes it again. An order that was priced and never paid, and never reached the handler, is not in that narrowing; it is readable by its identifier, where its status is the buyer's word for a purchase that has not finished. One kind of order is not in this list at all, with or without the flag: one that closed before anybody named a price for it, because the product was gone or a price question went unanswered. Every row here is written in a document that carries a sale price and those orders have none, so they are readable one at a time by their identifier, where the refusal says what became of them. A merchant reconciling against this list is reconciling against the orders that were priced. An order that ended with nothing charged and nothing held for its buyer leaves this list thirty days after it ended, when it is deleted.",
    query: OrderListQuerySchema,
    response: { document: OrderListSchema },
  },

  list_receipts: {
    method: "GET",
    path: "/v0/receipts",
    auth: "merchant_key",
    description:
      "The receipts belonging to the merchant whose key made this call: what was paid, when the facilitator confirmed payment or its chain transaction executed, when the price was fixed for the sale, when that price was true, and what became of the order. Those three moments are different facts: a chain-recovered payment uses its transaction block's time, not the time recovery found it. Every receipt marks test purchases, so a reader reconciling real money must check that field. Agentify writes a receipt once payment is confirmed and the goods are released or the parcel's shipment is recorded. A purchase that ended before payment, one whose payment is still unknown, and a paid order awaiting fulfillment or unfulfilled have no receipt. Verified recovery can release held goods with a receipt unless the merchant closed fulfillment; a late payment on a closed prepaid order instead leaves fulfillment incomplete. This list therefore does not account for all money received. It contains this merchant's receipts and nobody else's.",
    response: { document: ReceiptListSchema },
  },

  poll_worker: {
    method: "POST",
    path: "/v0/worker/poll",
    auth: "merchant_key",
    description:
      "Draws the next batch off this merchant's stream. The request is held open until something arrives or the wait window closes, and then answers with a batch of envelopes or an empty one; an empty batch is the ordinary answer to a quiet window and is not a failure. Delivery is not one rule for everything on this stream. An order arrives at least once: a merchant who does not answer is sent it again, and each attempt is a fresh envelope with an identifier of its own, so the only thing two attempts at one order have in common is the order they carry — which is why a handler recognises a repeat by the order's own identifier inside the payload and never by the envelope's. Nothing else here is ever re-offered. A price question our patience runs out on is resolved on our side rather than asked again, and what that costs the purchase depends on the card's mode. An event has no reply of any kind, so one that went into a response that never reached its worker is simply gone, and nothing afterwards says that anything went missing. Guarding against a repeat is right for an order and pointless for the other two; counting on a message to arrive is safe for an order and not for an event.",
    request: WorkerPollRequestSchema,
    response: { document: WorkerPollResponseSchema },
  },

  answer_order: {
    method: "POST",
    path: "/v0/orders/:order_id/answer",
    auth: "merchant_key",
    description:
      "What the merchant's handler returned for an order it was given: the goods, a refusal, or an acceptance. The SDK sends this itself, in every mode, and it is the only way a synchronous answer reaches us at all — there the handler's return is the delivery and the refusal, and the explicit deliver and refuse calls do not apply. An acceptance is answered with the word accepted — the order is taken on, and the goods follow through the deliver call — or with already_delivered when the order closed before the acceptance reached us, which a redelivered order makes ordinary rather than a fault. A synchronous order still waiting for its goods cannot be taken on, because the deliver call that would carry them later does not exist in that mode: the acceptance is refused with not_applicable_in_mode, the order is not sent to the handler again for it, and it closes on its deadline with nothing charged. A synchronous answer that arrives after its deadline is not an error: the work exists and a repeat purchase collects it, and the answer says so in the word purchase_already_closed.",
    request: HandlerAnswerSchema,
    response: { document: OrderCallResponseSchema },
  },

  deliver_order: {
    method: "POST",
    path: "/v0/orders/:order_id/deliver",
    auth: "merchant_key",
    description:
      "The goods for an order the merchant took on earlier. Repeating delivery against its identifier releases nothing twice and charges nothing twice. An unfulfilled order may receive late delivery until the merchant closes fulfillment; afterward this call is refused as fulfillment_closed. A parcel carries its shipment instead of goods: carrier, tracking number or null, and optional tracking page and expected window. Agentify records when the call arrived, the order reads shipped and the shipment cannot be changed: the same shipment succeeds on retry, a different one is refused as shipment_already_recorded.",
    request: DeliverySchema,
    response: { document: OrderCallResponseSchema },
  },

  close_order: {
    method: "POST",
    path: "/v0/orders/:order_id/close",
    auth: "merchant_key",
    description:
      "Stops future fulfillment through Agentify for this merchant's order and answers ok: true. The optional message is the merchant's statement to the buyer, which the buyer's agent reads as the merchant's own words; it establishes no refund or settled agreement. It is plain text of at most 2000 characters, an emoji counting as one, and one carrying HTML markup, a character reference, a control character other than the line feed, a bidirectional control character or half of a character cut in two is refused with 400, changing nothing. A retry also answers ok: true and keeps the first closure time and message. Closure keeps the original payment facts, the payment the buyer signed, goods already held and the order's history; it causes no new charge and releases nothing. It cancels no payment: a payment Agentify had already asked the facilitator to execute may still go through after the closure. When it does, the merchant receives order.unfulfilled with reason paid_after_closure, and the order is on the merchant's open order list until the merchant closes it again; that closure records its own time and message. An order whose goods were delivered or whose parcel's shipment is recorded is refused as fulfillment_complete, and one that ended without a charge and holds nothing for its buyer (rejected, declined, expired, cancelled) as nothing_to_close; neither refusal changes the order. An unknown order and another merchant's order are answered identically.",
    request: OrderCloseRequestSchema,
    response: { document: OrderCloseResponseSchema },
  },

  refuse_order: {
    method: "POST",
    path: "/v0/orders/:order_id/refuse",
    auth: "merchant_key",
    description:
      "A final \"this cannot be delivered\" for an order already taken on — the asynchronous mode's other closure verb. It exists only where an acceptance came first; in the synchronous mode the handler's own answer is the refusal and travels on the answer route instead, which is what the error code not_applicable_in_mode says from the other side. A temporary failure is not a refusal — it is an exception, a dead process or a dropped connection, and it is answered with another delivery.",
    request: RefusalSchema,
    response: { document: OrderCallResponseSchema },
  },

  accept_order: {
    method: "POST",
    path: "/v0/orders/:order_id/accept",
    auth: "merchant_key",
    description:
      "Takes an order on: the merchant will deliver. An empty body is a complete answer. A synchronous order still waiting for its goods cannot be taken on, because its goods travel only in the handler's answer: the call is refused with not_applicable_in_mode. The same order is taken on again every time it is redelivered, and the success carries no word: taking on an order that is already delivered succeeds here too, and this route does not tell the two apart. The answer route does, because it carries whichever of the three things a handler returned.",
    request: AcceptanceSchema,
    response: { document: OrderAcceptResponseSchema },
  },

  answer_quote: {
    method: "POST",
    path: "/v0/quotes/:price_id/answer",
    auth: "merchant_key",
    description:
      "The price and availability for a question that came off the worker stream, against the price_id that question carried. The acknowledgement says whether the answer arrived in time to price the purchase; when it did not, stock held against the question can be released. A price that is zero, not in USD or USDC, or written with fewer than two or more than six digits after the dot is refused as malformed_body with the reason as its message, and the question stays open for a corrected answer.",
    request: QuoteResponseSchema,
    response: { document: QuoteAnswerAckSchema },
  },

  list_catalog: {
    method: "GET",
    path: "/x402/catalog",
    auth: "none",
    description:
      "Products offered for sale, as an agent reads them. Each is the projection of a published card: our catalog identifier rather than the merchant's own key, the whole address it is bought at, and nothing about how the merchant's price is asked for beyond the fact that it will be asked again.",
    response: { document: CatalogPageSchema },
  },

  purchase_item: {
    method: "POST",
    path: "/x402/:item_id/purchase",
    auth: "none",
    description:
      "Buying one product. The payment is what stands in for authorisation, so there is no key on this call. It begins with the payment exchange of the x402 protocol: a call with no payment on it is answered with a challenge, which travels in a header and carries no document. What a paid purchase is answered with is the state of the order it made — the same document the status route answers with, whatever the card's mode and whether the purchase ended in the goods or in something else, so an agent that bought and an agent that came back later read one shape. That document names, in status_url, the whole address where the order is read again, which is where goods that come later are collected. No receipt of ours is in it: a receipt is the merchant's record of the sale and is read behind the merchant's key. What an agent is told about its own money is the price, the word for whether that money was real, and, once the charge has gone through, the transaction that paid it, in the document's transaction and in the standard x402 payment response header on this answer, whatever the card's mode and whether or not the goods have come; an answer given while the charge has not gone through carries neither. The address answers on GET as well as on POST, because that is how the validators and crawlers that list a paid resource ask for it. An unpaid call that carries no document — a GET, or a POST with nothing or with an empty document — is answered with the challenge and never a purchase, and a GET is never read for payment; the challenge describes the purchase, which is a POST with a JSON body. The price a challenge names holds for thirty seconds, and the order opened for it lapses with it. The challenge's maxTimeoutSeconds is longer, because it is how long the signed authorisation has to stay valid for a purchase delivered in the answer to be charged after its goods; it is not a time to pay in, so sign and present the payment at once. Where the goods are still to be made, a payment for such a purchase whose authorisation would end before that charge, with a margin for what cannot be counted exactly, is refused as payment_not_verified, before anything is made or charged, and the same order can be paid again with a fresh signature while its price holds. An unpaid POST that carries that document is answered with the price of the very order it opened, and a document of some other shape is refused with the fields that are wrong. That challenge names the order by a payment reference in its payment requirements, extra.payment_ref, which comes back with the payment and binds it to that order; it is not the order's identifier, which comes in the purchase's answer and never in the payment request, and nothing but this call reads it. A payment for an order that is already over with nothing held for it is refused as payment_not_taken, saying what became of the order in words that name no order. A payer whose answer was lost signs the same challenge again from the same wallet: an order under way, delivered or unfulfilled is answered with the order, with no second charge, while one that ended with nothing charged, or whose payment's outcome is not known yet, is refused in words that say so. For an order already paid, that payment is checked by this gateway and not by the payment layer and is never charged, so the wallet need not hold the price again; it has to be a fresh signature that is still valid, because the payment that paid the order can be read from the chain and is refused, and a fresh signature from any other wallet is refused as not_this_purchase. Asking this address again without the kept challenge starts a new purchase with a new payment reference, which is charged again once paid, so a lost answer is recovered only by signing the kept challenge again. A product that is not on sale answers neither method with a challenge: it is refused, so that a catalog built from these challenges never carries a product nobody can buy. Two refusals of an unpaid purchase come before its price is asked and charge nothing, and both are retryable: seller_busy, with HTTP 429 and a Retry-After, while twenty of the seller's purchases already wait for payment, and seller_not_taking_orders, for a purchase that charges before its goods while the seller's own process has not polled for ten minutes, which a payment for such a purchase is refused with too.",
    request: PurchaseRequestSchema,
    also_answers_on: ["GET"],
    response: { document: AgentOrderStatusSchema },
  },

  get_order_status: {
    method: "GET",
    path: "/x402/orders/:order_id/status",
    auth: "order_id",
    description:
      "What became of a purchase, for the agent that made it, and the route on which an agent that bought goods that come later collects them. Every answer that carries the order document names this address in status_url, whole and ready to call. A paid order with no delivery by its card's deadline reads unfulfilled, as does a paid order the merchant refuses or leaves behind. That says fulfillment failed; it makes no claim about a refund or an agreement between buyer and merchant. Late goods can still arrive and appear here until the merchant closes fulfillment through Agentify, and merchant_closure then attributes any explanation to the merchant. payment_status always states the original payment on its own. A payment whose outcome was unknown keeps being checked after closure, without a new charge and without releasing goods, and the document says so once it is known. Knowing the order's identifier is the proof, so this call takes no key. The identifier reaches the agent that bought in the purchase's answer, and the merchant, but never the payment requirements, which carry a separate payment_ref; this call answers that reference exactly as it answers an identifier that names no order. An order that ended with nothing charged and nothing held for its buyer is deleted thirty days after it ended, and its identifier is answered from then on as one that names no order. Whoever mounts the route reads which door a call is behind from its auth and never from its address, and answers an identifier that names no order exactly as any other unknown one, or the refusal becomes a way of counting the orders behind it.",
    response: { document: AgentOrderStatusSchema },
  },
}) satisfies Readonly<Record<string, RouteDefinition>>;

/** The name of one call in the table. */
export type RouteName = keyof typeof API_ROUTES;

/** A path parameter's name: lowercase, as fields on the wire are written. */
const PARAMETER_NAME = "[a-z][a-z0-9_]*";

// Built fresh on each call: a global regular expression carries a cursor
// between calls, and sharing one between a scan and a replace is a bug.
const pathParameterPattern = (): RegExp => new RegExp(`:(${PARAMETER_NAME})`, "g");

/** The parameters an address takes, in the order it writes them. */
export const pathParamsOf = (path: string): string[] =>
  [...path.matchAll(pathParameterPattern())].map((match) => match[1] ?? "");

/**
 * The address of one call, with its parameters filled in and URL-encoded.
 *
 * Throws a `TypeError` for a missing or empty value, a value for a parameter
 * the address does not take, a value that is not a string, and "." or "..",
 * which a URL resolver would walk. Each is a bug in the caller, not a
 * condition to handle. Values are looked up with `Object.hasOwn`, so a
 * parameter named `constructor` finds nothing on the prototype.
 */
export const expandPath = (path: string, values: Readonly<Record<string, string>>): string => {
  const wanted = pathParamsOf(path);
  const unwanted = Object.keys(values).filter((name) => !wanted.includes(name));

  if (unwanted.length > 0) {
    throw new TypeError(
      `"${path}" takes ${wanted.length === 0 ? "no path parameters" : wanted.join(", ")}, so there is nowhere to put ${unwanted.join(", ")}`,
    );
  }

  return path.replace(pathParameterPattern(), (_match, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;

    if (typeof value !== "string" || value === "") {
      throw new TypeError(`"${path}" needs a value for ":${name}" and was given none`);
    }

    if (value === "." || value === "..") {
      throw new TypeError(
        `"${path}" was given ${JSON.stringify(value)} for ":${name}", which is a step through the path rather than a value in it`,
      );
    }

    return encodeURIComponent(value);
  });
};

/**
 * The routes a gateway may serve: every route whose door has been chosen.
 * Mount from this list rather than from `API_ROUTES`, so that a route marked
 * `undecided` is never served to the whole world for want of a key check.
 */
export const mountableRoutes = (): [RouteName, RouteDefinition][] =>
  (Object.entries(API_ROUTES) as [RouteName, RouteDefinition][]).filter(
    ([, route]) => route.auth !== "undecided",
  );

export type OrderWithStatus = z.infer<typeof OrderWithStatusSchema>;
export type OrderList = z.infer<typeof OrderListSchema>;
export type MerchantCardList = z.infer<typeof MerchantCardListSchema>;
export type ReceiptList = z.infer<typeof ReceiptListSchema>;
export type OrderListQuery = z.infer<typeof OrderListQuerySchema>;
export type WorkerPollRequest = z.infer<typeof WorkerPollRequestSchema>;
export type WorkerPollResponse = z.infer<typeof WorkerPollResponseSchema>;
export type OrderCallResponse = z.infer<typeof OrderCallResponseSchema>;
export type OrderAcceptResponse = z.infer<typeof OrderAcceptResponseSchema>;
export type OrderCloseResponse = z.infer<typeof OrderCloseResponseSchema>;
export type QuoteAnswerAck = z.infer<typeof QuoteAnswerAckSchema>;
export type PurchaseRequest = z.infer<typeof PurchaseRequestSchema>;
export type AgentOrderStatus = z.infer<typeof AgentOrderStatusSchema>;
export type CatalogPage = z.infer<typeof CatalogPageSchema>;
