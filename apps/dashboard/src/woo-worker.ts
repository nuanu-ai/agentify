/**
 * Filling the orders of a merchant whose catalogue came from a WooCommerce
 * shop.
 *
 * A merchant who connected a shop wrote no code. Their products are on sale,
 * agents buy them, and something has to turn a paid order here into an order
 * there — so the dashboard stands in as their handler, drawing their own stream
 * and answering with the calls any merchant's worker makes, the way ADR-0004
 * says a worker calls them. It calls the gateway's application inside the
 * process the two share rather than over the API (ADR-0030), as the merchant on
 * the account that connected the shop.
 *
 * The hand-over itself is the gateway's queue-shaped effect and it is not
 * reimplemented here. An order reaches this because the envelope carrying it
 * was written into the same transaction as the state that implies it
 * (ADR-0013), and an order this leaves unanswered is handed over again by the
 * order machine, which is the one thing that knows how many attempts are left.
 * So the two answers below are the whole vocabulary: a delivery, a refusal, or
 * nothing at all — and nothing at all is the one that means "ask me again".
 *
 * The rule that shapes everything else in this file: **a merchant's shop is not
 * ours to write to twice.** A delivery is at least once, so the same sale can
 * arrive here more than once, and a second order in somebody's shop is a second
 * thing they pick, pack and post for one payment. The ledger in `woo-shops.ts`
 * is claimed before the shop is called and completed after, and the case it
 * exists for is the one in the middle: an attempt that reached the point of
 * calling and never learned the outcome. That one is refused rather than
 * retried, in words that say it is not knowable from here — which is the
 * difference between "there is no order" and "I do not know whether there is
 * one".
 */

import { createHash } from "node:crypto";
import {
  type HandlerAnswer,
  localityOf,
  type Order,
  type QuoteRequest,
  type QuoteResponse,
  type ShipToLocality,
  ShipToSchema,
} from "@nuanu-ai/agentify-contracts";
import type { Acting, GatewayClient } from "./gateway.js";
import type { Identity } from "./identity.js";
import { amountOfCents, centsOf, productIdFromMerchantItem } from "./woo-catalog.js";
import {
  createTheOrderInTheShop,
  createTheParcelInTheShop,
  inspectProductInTheShop,
  type OrderMade,
  type ParcelMade,
  type ParcelSold,
  type ProductInspection,
  type RatesRead,
  type ShipmentRead,
  type ShippingRate,
  type ShopKeys,
  type SoldItem,
  shipmentInTheShop,
  shippingRatesInTheShop,
} from "./woo-shop.js";
import type { WooConnection, WooOrderFacts, WooPermission, WooShops } from "./woo-shops.js";

/** What filling one order needs beyond the order and the connection. */
export interface Filling {
  readonly shops: WooShops;
  readonly now: () => Date;
  /**
   * How the shop is reached, with the real call as the default.
   *
   * A parameter so that the decisions in this file can be read off a test
   * without a WooCommerce anywhere near it. A deployment passes nothing.
   */
  readonly placeOrder?: (keys: ShopKeys, sold: SoldItem) => Promise<OrderMade>;
  /**
   * How the shop is asked whether the product is still the one supported
   * downloadable file, with the real inspection as the default. A price
   * question and an order read the product the same way. A deployment passes
   * nothing.
   */
  readonly inspectProduct?: (
    connection: WooConnection,
    merchantItemId: string,
  ) => Promise<ProductInspection>;
  /**
   * How the shop is asked what shipping a parcel to a place costs, with the
   * shop's own cart as the default. A deployment passes nothing.
   */
  readonly shippingRates?: (
    connection: WooConnection,
    productId: string,
    place: ShipToLocality,
  ) => Promise<RatesRead>;
  /** How long a price question may take; a deployment passes nothing. */
  readonly quoteWithinMs?: number;
  /**
   * How a parcel's paid order is created in the shop, with the real call as
   * the default. A deployment passes nothing.
   */
  readonly placeParcel?: (keys: ShopKeys, sold: ParcelSold) => Promise<ParcelMade>;
  /** Test seam for the durable quote binding; production reads WooShops. */
  readonly quotedProduct?: (
    connection: WooConnection,
    priceId: string,
    merchantItemId: string,
  ) => Promise<string | null>;
}

/**
 * What this merchant's handler answers for one order, or null for no answer at
 * all.
 *
 * Null is not a failure to decide. It is the answer that means the sale is
 * still live and the order should come round again — the shop did not answer,
 * so nothing about this sale has been settled and a refusal would close for
 * good something that a minute from now would go through.
 */
export const fillFromTheShop = async (
  order: Order,
  connection: WooConnection,
  orderEmail: string,
  parts: Filling,
): Promise<HandlerAnswer | null> => {
  // A parcel's order carries where it goes, and nothing else does (ADR-0032).
  if (order.ship_to !== undefined) {
    return await fillParcelFromTheShop(order, connection, orderEmail, parts);
  }
  const place = parts.placeOrder ?? createTheOrderInTheShop;
  const known = await parts.shops.knownOrder(order.id);
  if (known?.kind === "placed") {
    return { delivered: deliveryFromWooPermission(known.permission) };
  }
  if (known?.kind === "placed_parcel") {
    // A download's order bound as a parcel's cannot be written by anything
    // here; whatever it is, it is not ordered a second time.
    return unknownCreation(order.id, connection.shopUrl, parts.now());
  }
  if (known?.kind === "precreate_refused") {
    return {
      refused: {
        code: "cannot_fulfill",
        message:
          "This paid order was already refused before WooCommerce order creation. Reconnecting the shop does not create it again automatically.",
      },
    };
  }
  if (known?.kind === "unknown") {
    return unknownCreation(order.id, connection.shopUrl, known.attemptedAt);
  }
  const inspected = await productInTheShop(connection, order.merchant_item_id, parts);
  const eligible = inspected.ok ? inspected.product : null;
  const quoted =
    order.price_id === undefined
      ? null
      : parts.quotedProduct === undefined
        ? await parts.shops.quotedProduct(
            connection.accountId,
            order.price_id,
            order.merchant_item_id,
          )
        : await parts.quotedProduct(connection, order.price_id, order.merchant_item_id);
  const facts: WooOrderFacts = {
    shopOrigin: new URL(connection.shopUrl).origin,
    connectionRevision: connection.revision,
    merchantItemId: order.merchant_item_id,
    priceId: order.price_id ?? "unbound-price-id",
    productId:
      eligible?.productId ??
      productIdFromMerchantItem(connection.shopUrl, order.merchant_item_id) ??
      "",
    // Recovery must restore the product the buyer accepted, never bless the
    // changed product that caused this refusal. With no accepted quote there
    // is deliberately no product fingerprint recovery can satisfy.
    productFingerprint: quoted ?? "unbound-price-id",
    amount: order.price.amount,
    currency: order.price.currency,
  };
  if (eligible === null) {
    await parts.shops.recordPrecreateRefusal(connection.accountId, order.id, facts, parts.now());
    // Refused either way, and the reason is the one that is true: a shop that
    // did not answer has said nothing about the product, so this does not say
    // the product stopped being sold.
    return {
      refused: {
        code: "cannot_fulfill",
        message:
          !inspected.ok && inspected.again
            ? "The shop did not answer when this order was placed, so no WooCommerce order was created."
            : "This shop product is no longer a supported single-file download, so no WooCommerce order was created.",
      },
    };
  }
  if (eligible.kind !== "download") {
    await parts.shops.recordPrecreateRefusal(connection.accountId, order.id, facts, parts.now());
    return {
      refused: {
        code: "cannot_fulfill",
        message:
          "This shop product is no longer a supported single-file download, so no WooCommerce order was created.",
      },
    };
  }
  if (
    eligible.price.amount !== order.price.amount ||
    eligible.price.currency !== order.price.currency
  ) {
    await parts.shops.recordPrecreateRefusal(connection.accountId, order.id, facts, parts.now());
    return {
      refused: {
        code: "cannot_fulfill",
        message:
          "The shop's product or price changed after this purchase was quoted, so no WooCommerce order was created.",
      },
    };
  }
  if (quoted === null || quoted !== eligible.fingerprint) {
    await parts.shops.recordPrecreateRefusal(connection.accountId, order.id, facts, parts.now());
    return {
      refused: {
        code: "cannot_fulfill",
        message:
          "The shop's downloadable product changed after this purchase was quoted, so no WooCommerce order was created.",
      },
    };
  }

  if (connection.permissions !== "read_write") {
    // The shop granted less than we asked for, so every sale on this connection
    // ends here. The merchant is told which it is, in their own log and on
    // their own connection screen; the agent is told the fact and no more,
    // because who granted what to whom is the merchant's business and nothing
    // an agent could act on.
    console.error(
      `[dashboard] the shop at ${connection.shopUrl} granted ${JSON.stringify(connection.permissions)}` +
        " access, which cannot create an order, so every sale on it is refused",
    );
    await parts.shops.recordPrecreateRefusal(connection.accountId, order.id, facts, parts.now());
    return {
      refused: {
        code: "cannot_fulfill",
        message:
          "The shop this product is sold from cannot take an order from us, so nothing was" +
          " delivered and the sale did not go through.",
      },
    };
  }

  const claim = await parts.shops.claimOrder(connection.accountId, order.id, facts, parts.now());

  if (claim.kind === "placed") {
    // The same sale, handed over a second time. The shop already has the order
    // and the buyer gets the same number they would have got the first time.
    return { delivered: deliveryFromWooPermission(claim.permission) };
  }

  if (claim.kind === "precreate_refused") {
    return {
      refused: {
        code: "cannot_fulfill",
        message: "This paid order was already refused before WooCommerce order creation.",
      },
    };
  }

  if (claim.kind === "unknown") {
    return unknownCreation(order.id, connection.shopUrl, claim.attemptedAt);
  }
  if (claim.kind === "placed_parcel") {
    return unknownCreation(order.id, connection.shopUrl, parts.now());
  }

  const made = await place(connection, {
    orderId: order.id,
    productId: eligible.productId,
    // Not the buyer's, which is why the parameter is not called that. Creating
    // an order makes WooCommerce send mail to whatever is on it and nothing in
    // the request can stop that, so whose address belongs here is a product
    // question nobody has answered; until somebody does it is the merchant's
    // own, and ADR-0023 says so rather than this pretending it is settled.
    email: orderEmail,
    price: { amount: order.price.amount, currency: order.price.currency },
    download: { id: eligible.downloadId, name: eligible.fileName },
  });

  if (made.ok) {
    const permission: WooPermission = {
      shopOrigin: new URL(connection.shopUrl).origin,
      productId: eligible.productId,
      orderKey: made.orderKey,
      downloadId: made.downloadId,
      fileName: eligible.fileName,
      emailUid: createHash("sha256").update(orderEmail).digest("hex"),
      orderNumber: made.number,
    };
    const bound = await parts.shops.recordOrder(
      order.id,
      { id: made.id, number: made.number, permission },
      parts.now(),
    );
    if (bound) {
      return { delivered: deliveryFromWooPermission(permission) };
    }
    const durable = await parts.shops.knownOrder(order.id);
    if (
      durable?.kind === "placed" &&
      durable.id === made.id &&
      durable.number === made.number &&
      samePermission(durable.permission, permission)
    ) {
      return { delivered: deliveryFromWooPermission(durable.permission) };
    }
    console.error(
      `[dashboard] ${order.id} was created in WooCommerce but its delivery was not durably bound`,
    );
    return null;
  }

  if (made.again) {
    // Nothing is answered and the claim stays: the request may have reached the
    // shop, so the next attempt has to meet "we do not know" rather than a
    // clean slate.
    console.error(`[dashboard] ${order.id} has no usable WooCommerce creation result`);
    return null;
  }

  // A response after POST is not proof that the remote side did not commit.
  // Keep the create_unknown obligation and require exact-id recovery rather
  // than turning a proxy/plugin-rewritten 4xx into a second POST.
  console.error(`[dashboard] ${order.id} has no verifiable WooCommerce creation result`);
  return unknownCreation(order.id, connection.shopUrl, parts.now());
};

/**
 * What this merchant's handler answers for a paid parcel: the order taken on
 * once the shop holds a paid order shipping to the buyer, a refusal where
 * none can be made, or nothing at all while the shop does not answer.
 *
 * The product is held to the one the price was bound to, and the shipping to
 * what was paid above the goods: the shop's cart is asked again for the place
 * the order pays for, and the rate costing exactly that difference is the
 * rate that was sold — the cheapest at the price question, and still there if
 * the shop has added a cheaper one since. Where no rate costs it any more, the
 * order is refused before anything reaches the shop, and is a refund owed.
 *
 * A shop that does not answer is not a refusal here. A parcel has days to
 * ship, so the order comes round again on its next hand-over and nothing is
 * written until the shop has said something. Once the shop's answer shows the
 * order with the address on it, `accepted` lets Agentify erase its copy
 * (ADR-0032); nothing of the address is written to the ledger or the log on
 * any path.
 */
const fillParcelFromTheShop = async (
  order: Order,
  connection: WooConnection,
  orderEmail: string,
  parts: Filling,
): Promise<HandlerAnswer | null> => {
  const known = await parts.shops.knownOrder(order.id);
  if (known?.kind === "placed_parcel") return { accepted: {} };
  if (known?.kind === "precreate_refused") {
    return {
      refused: {
        code: "cannot_fulfill",
        message: "This paid order was already refused before WooCommerce order creation.",
      },
    };
  }
  if (known !== null) {
    return unknownCreation(
      order.id,
      connection.shopUrl,
      known.kind === "unknown" ? known.attemptedAt : parts.now(),
    );
  }
  const address = ShipToSchema.safeParse(order.ship_to);
  const productId = productIdFromMerchantItem(connection.shopUrl, order.merchant_item_id);
  const quoted =
    order.price_id === undefined
      ? null
      : parts.quotedProduct === undefined
        ? await parts.shops.quotedProduct(
            connection.accountId,
            order.price_id,
            order.merchant_item_id,
          )
        : await parts.quotedProduct(connection, order.price_id, order.merchant_item_id);
  const facts: WooOrderFacts = {
    kind: "parcel",
    shopOrigin: new URL(connection.shopUrl).origin,
    connectionRevision: connection.revision,
    merchantItemId: order.merchant_item_id,
    priceId: order.price_id ?? "unbound-price-id",
    productId: productId ?? "",
    productFingerprint: quoted ?? "unbound-price-id",
    amount: order.price.amount,
    currency: order.price.currency,
  };
  const refuse = async (message: string): Promise<HandlerAnswer> => {
    await parts.shops.recordPrecreateRefusal(connection.accountId, order.id, facts, parts.now());
    return { refused: { code: "cannot_fulfill", message } };
  };
  if (!address.success || productId === null) {
    return await refuse(
      "This paid parcel's order names no address or no product in this shop, so no WooCommerce order was created.",
    );
  }
  const [inspected, rates] = await Promise.all([
    productInTheShop(connection, order.merchant_item_id, parts),
    (
      parts.shippingRates ??
      ((keys: WooConnection, id: string, where: ShipToLocality) =>
        shippingRatesInTheShop(keys.shopUrl, id, where))
    )(connection, productId, localityOf(address.data)),
  ]);
  if (!inspected.ok && inspected.again) {
    console.error(`[dashboard] ${order.id} waits: ${inspected.why}`);
    return null;
  }
  if (!inspected.ok || inspected.product.kind !== "parcel") {
    return await refuse(
      "This shop product is no longer a parcel this connector sells, so no WooCommerce order was created.",
    );
  }
  const product = inspected.product;
  if (quoted === null || quoted !== product.fingerprint) {
    return await refuse(
      "The shop's product changed after this purchase was quoted, so no WooCommerce order was created.",
    );
  }
  if (!rates.ok && rates.again) {
    console.error(`[dashboard] ${order.id} waits: ${rates.why}`);
    return null;
  }
  const goods = centsOf(product.price.amount);
  const paid = order.price.currency === product.price.currency ? centsOf(order.price.amount) : null;
  const rate =
    !rates.ok || goods === null || paid === null
      ? undefined
      : rates.rates.find((one) => centsOf(one.cost) === paid - goods);
  if (rate === undefined) {
    return await refuse(
      "The shop's shipping to this place no longer costs what was paid for it, so no WooCommerce order was created.",
    );
  }
  if (connection.permissions !== "read_write") {
    console.error(
      `[dashboard] the shop at ${connection.shopUrl} granted ${JSON.stringify(connection.permissions)}` +
        " access, which cannot create an order, so every sale on it is refused",
    );
    return await refuse(
      "The shop this product is sold from cannot take an order from us, so nothing was" +
        " shipped and the sale did not go through.",
    );
  }

  const claim = await parts.shops.claimOrder(connection.accountId, order.id, facts, parts.now());
  if (claim.kind === "placed_parcel") return { accepted: {} };
  if (claim.kind === "precreate_refused") {
    return {
      refused: {
        code: "cannot_fulfill",
        message: "This paid order was already refused before WooCommerce order creation.",
      },
    };
  }
  if (claim.kind !== "ours") {
    return unknownCreation(
      order.id,
      connection.shopUrl,
      claim.kind === "unknown" ? claim.attemptedAt : parts.now(),
    );
  }

  const made = await (parts.placeParcel ?? createTheParcelInTheShop)(connection, {
    orderId: order.id,
    productId,
    email: orderEmail,
    paid: { amount: order.price.amount, currency: order.price.currency },
    goods: product.price.amount,
    rate,
    address: address.data,
  });
  if (made.ok) {
    const bound = await parts.shops.recordOrder(
      order.id,
      { id: made.id, number: made.number, permission: null },
      parts.now(),
    );
    if (bound) return { accepted: {} };
    const durable = await parts.shops.knownOrder(order.id);
    if (
      durable?.kind === "placed_parcel" &&
      durable.id === made.id &&
      durable.number === made.number
    ) {
      return { accepted: {} };
    }
    console.error(
      `[dashboard] ${order.id} was created in WooCommerce but its order was not durably bound`,
    );
    return null;
  }
  // From here the shop may hold a paid order shipping to the buyer while the
  // sale is refused and owes a refund, so the log names the shop's order
  // where the shop named it: that order is not to be shipped.
  const inTheShop =
    made.id === undefined
      ? ""
      : `; the shop's order ${made.id} does not match it and is not to be shipped`;
  if (made.again) {
    // Not answered, and the claim stays: the order may be in the shop, so the
    // next hand-over meets "we do not know" rather than a clean slate.
    console.error(`[dashboard] ${order.id} has no usable WooCommerce creation result${inTheShop}`);
    return null;
  }
  console.error(
    `[dashboard] ${order.id} has no verifiable WooCommerce creation result${inTheShop}`,
  );
  return unknownCreation(order.id, connection.shopUrl, parts.now());
};

const samePermission = (left: WooPermission, right: WooPermission): boolean =>
  left.shopOrigin === right.shopOrigin &&
  left.productId === right.productId &&
  left.orderKey === right.orderKey &&
  left.downloadId === right.downloadId &&
  left.fileName === right.fileName &&
  left.emailUid === right.emailUid &&
  left.orderNumber === right.orderNumber;

const unknownCreation = (orderId: string, shopUrl: string, attemptedAt: Date): HandlerAnswer => {
  console.error(
    `[dashboard] ${orderId} was already being placed in the shop at ${shopUrl} at` +
      ` ${attemptedAt.toISOString()} and that attempt never reported back. It is refused` +
      " rather than placed again; look for an order carrying this identifier as its" +
      " transaction id before deciding nothing happened.",
  );
  return {
    refused: {
      code: "cannot_fulfill",
      message:
        `An earlier attempt to place ${orderId} in the shop was interrupted and never reported` +
        " back, so whether the shop holds an order for it is not something this can find out." +
        " It is refused rather than ordered a second time, because a second order is a second" +
        " thing the shop has to fulfil.",
    },
  };
};

export const deliveryFromWooPermission = (permission: WooPermission): Record<string, unknown> => {
  const address = new URL(permission.shopOrigin);
  address.pathname = "/";
  address.search = new URLSearchParams({
    download_file: permission.productId,
    order: permission.orderKey,
    uid: permission.emailUid,
    key: permission.downloadId,
  }).toString();
  return {
    download_url: address.toString(),
    file_name: permission.fileName,
    order_number: permission.orderNumber,
  };
};

/** What the loop needs to fill one connected shop's orders. */
export interface WorkingParts extends Filling {
  /** How the account behind a connection is read: its address and its merchant. */
  readonly identity: Pick<Identity, "byId">;
  readonly clientFor: (acting: Acting) => GatewayClient;
  /** How long one poll holds the stream open. */
  readonly waitSeconds?: number;
  /**
   * How the shop is asked whether a parcel's order shipped, with the real read
   * as the default. A deployment passes nothing.
   */
  readonly readShipment?: (
    keys: ShopKeys,
    wooOrderId: string,
    orderId: string,
  ) => Promise<ShipmentRead>;
}

/**
 * How long one poll waits.
 *
 * Short enough that a merchant stopping the dashboard does not wait on it, and
 * long enough that a synchronous order is picked up the moment it is written
 * rather than on the next turn — which matters, because a synchronous purchase
 * is an agent holding a request open while this happens.
 */
const WAIT_SECONDS = 5;

/**
 * One turn for one connected shop: draw the stream, fill what came, answer.
 *
 * It answers with how many envelopes were drawn, events included, which is
 * what the loop reads to decide whether to come straight back. The gateway
 * hands out one envelope a poll, so an event is often all a turn draws, and a
 * turn that drew one is not a quiet stream.
 */
export const turnOnce = async (connection: WooConnection, parts: WorkingParts): Promise<number> => {
  const person = await parts.identity.byId(connection.accountId);
  if (person === null || person.merchant === null) {
    // The account behind this connection is gone, or has no merchant on it.
    // Nothing can be drawn as somebody who does not exist.
    console.error(
      `[dashboard] the WooCommerce connection for ${connection.accountId} names an account with no` +
        " merchant on it, so its orders cannot be drawn",
    );
    return 0;
  }

  const gateway = parts.clientFor({ merchantId: person.merchant.id, email: person.email });
  const drawn = await gateway.pollWorker(parts.waitSeconds ?? WAIT_SECONDS);
  if (!drawn.ok) {
    console.error(`[dashboard] the WooCommerce worker could not draw its stream: ${drawn.why}`);
    return 0;
  }

  for (const envelope of drawn.document.envelopes) {
    if (envelope.kind === "quote_request") {
      const answer =
        connection.permissions !== "read_write"
          ? { available: false as const, as_of: parts.now().toISOString() }
          : await quoteFromTheShop(connection, envelope.payload, parts.now(), parts);
      const said = await gateway.answerQuote(envelope.payload.price_id, answer);
      if (!said.ok) {
        console.error(
          `[dashboard] the price answer for ${envelope.payload.price_id} was not accepted: ${said.why}`,
        );
      }
      continue;
    }
    // Events have no reply. Reading one here would be pretending to answer it.
    if (envelope.kind !== "order") {
      continue;
    }
    const answer = await fillFromTheShop(envelope.payload, connection, person.email, parts);
    if (answer === null) {
      continue;
    }
    const said = await gateway.answerOrder(envelope.payload.id, answer);
    if (!said.ok) {
      console.error(
        `[dashboard] the answer for ${envelope.payload.id} was not accepted: ${said.why}`,
      );
    }
  }
  return drawn.document.envelopes.length;
};

/**
 * How long a price question may take, from the moment it is drawn.
 *
 * The gateway waits five seconds for a price (`QUOTE_RESPONSE_MS`) and then
 * reads the merchant as silent, so an answer later than that answers nobody.
 * Four seconds leaves the rest for the answer to travel, and keeps a slow
 * shop from holding up the questions and orders queued behind this one.
 */
const QUOTE_WITHIN_MS = 4_000;

/** What a piece of work came to, or null where it did not finish in time. */
const inTime = async <T>(work: Promise<T>, ms: number): Promise<T | null> => {
  let cut: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    cut = setTimeout(() => resolve(null), ms);
  });
  // A shop that answers after the deadline answers nobody, and what it says
  // then must not surface as a failure of the turn that stopped waiting.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(cut);
  }
};

/** What the cheapest of the shop's rates costs, in cents, or null where there is none. */
const cheapestCents = (rates: readonly ShippingRate[]): bigint | null => {
  let cheapest: bigint | null = null;
  for (const rate of rates) {
    const cost = centsOf(rate.cost);
    if (cost !== null && (cheapest === null || cost < cheapest)) cheapest = cost;
  }
  return cheapest;
};

/**
 * What this merchant's handler answers when an agent asks for a price: the
 * shop's own price for the product as it stands, with that product bound to
 * the price so the order paying it can be held to it — or no price at all.
 *
 * A parcel's price is the goods and the shop's cheapest rate to the place the
 * question carries, added in cents (ADR-0023). The product is bound to the
 * price and the rate is not: the rate says where the buyer is, and a binding
 * is kept for good, so the order asks the shop again for the place it pays for.
 *
 * A price that was already bound to another product is not moved to this one.
 * The order comes back with the price identifier and is held to what it was
 * first bound to, so a second answer naming a different download would be a
 * price for goods no order could be filled against.
 */
export const quoteFromTheShop = async (
  connection: WooConnection,
  question: QuoteRequest,
  at: Date,
  parts: Filling,
): Promise<QuoteResponse> => {
  const unavailable: QuoteResponse = { available: false, as_of: at.toISOString() };
  /** Not available, with the reason in the merchant's log and no word of the place. */
  const unpriced = (why: string): QuoteResponse => {
    console.error(
      `[dashboard] ${question.merchant_item_id} has no price for ${question.price_id}: ${why}`,
    );
    return unavailable;
  };
  const productId = productIdFromMerchantItem(connection.shopUrl, question.merchant_item_id);
  const place = question.ship_to;
  // Asked of the shop at the same time as the product is, because the two
  // together have to fit in the time a price question has.
  const shipping =
    place === undefined || productId === null
      ? Promise.resolve(null)
      : (
          parts.shippingRates ??
          ((keys: WooConnection, id: string, where: ShipToLocality) =>
            shippingRatesInTheShop(keys.shopUrl, id, where))
        )(connection, productId, place);
  const read = await inTime(
    Promise.all([productInTheShop(connection, question.merchant_item_id, parts), shipping]),
    parts.quoteWithinMs ?? QUOTE_WITHIN_MS,
  );
  if (read === null) return unpriced("the shop did not answer in time");
  const [inspected, rates] = read;
  if (!inspected.ok) return unavailable;
  const product = inspected.product;
  // A question with a place is a parcel's card, and the goods alone are not a
  // price it can be sold at.
  if (place !== undefined && product.kind !== "parcel") {
    return unpriced("the product in the shop is no longer a parcel");
  }
  let price = product.price;
  if (product.kind === "parcel") {
    if (rates === null) return unpriced("the question carries no place to ship to");
    if (!rates.ok) return unpriced(rates.why);
    const goods = centsOf(product.price.amount);
    const carriage = cheapestCents(rates.rates);
    if (goods === null || carriage === null) {
      return unpriced("the shop has no shipping rate to that place");
    }
    price = { amount: amountOfCents(goods + carriage), currency: product.price.currency };
  }
  const recorded = await parts.shops.recordQuote(
    connection.accountId,
    question.price_id,
    question.merchant_item_id,
    product.fingerprint,
    new Date(question.expires_at),
    at,
  );
  return recorded ? { available: true, price, as_of: at.toISOString() } : unavailable;
};

/** The product as the shop has it now, read the one way both answers read it. */
const productInTheShop = (
  connection: WooConnection,
  merchantItemId: string,
  parts: Filling,
): Promise<ProductInspection> =>
  (parts.inspectProduct ?? inspectProductInTheShop)(connection, merchantItemId);

/**
 * One pass over every placed parcel of every connected shop: whatever the
 * shop now says about each, said onward.
 *
 * A parcel's order the merchant marked Completed is recorded with the gateway
 * as shipped, which is the last thing the agent is told about it (ADR-0033),
 * and is followed no further. One the shop ended without completing it is
 * let go without a word to the gateway: it never shipped, and its time to ship
 * running out makes it a refund owed. A gateway that did not answer is asked
 * again on the next pass; one that refused the shipment has said all it will,
 * and the refusal is in the merchant's log. Everything else waits.
 *
 * Shops are read one after another and a shop that throws is passed over for
 * this pass, so one merchant's broken shop does not keep another's parcels
 * from shipping.
 */
export const followShipments = async (
  parts: Pick<WorkingParts, "shops" | "identity" | "clientFor" | "now" | "readShipment">,
): Promise<void> => {
  const read = parts.readShipment ?? shipmentInTheShop;
  for (const connection of await parts.shops.connections()) {
    try {
      const parcels = await parts.shops.parcelsToFollow(connection.accountId);
      if (parcels.length === 0) continue;
      const person = await parts.identity.byId(connection.accountId);
      if (person === null || person.merchant === null) continue;
      const gateway = parts.clientFor({ merchantId: person.merchant.id, email: person.email });
      const origin = new URL(connection.shopUrl).origin;
      for (const parcel of parcels) {
        if (parts.now().getTime() - parcel.placedAt.getTime() > FOLLOWED_FOR_MS) {
          await parts.shops.endParcel(parcel.orderId, "closed", parts.now());
          console.error(
            `[dashboard] ${parcel.orderId} was not completed in the shop within thirty days of` +
              " being placed, and is followed no further",
          );
          continue;
        }
        if (parcel.shopOrigin !== origin) {
          console.error(
            `[dashboard] ${parcel.orderId} was sold from ${parcel.shopOrigin}, and its order is not` +
              ` read in ${origin}, the shop this account connects now`,
          );
          continue;
        }
        const said = await read(connection, parcel.wooOrderId, parcel.orderId);
        if (said.kind === "waiting") continue;
        if (said.kind === "unknown") {
          console.error(`[dashboard] whether ${parcel.orderId} shipped is not known: ${said.why}`);
          continue;
        }
        if (said.kind === "ended") {
          await parts.shops.endParcel(parcel.orderId, "closed", parts.now());
          console.error(
            `[dashboard] the shop ended ${parcel.orderId} as ${said.status} without completing it;` +
              " it is followed no further and becomes a refund owed when its time to ship runs out",
          );
          continue;
        }
        const recorded = await gateway.deliverOrder(parcel.orderId, said.shipment);
        if (recorded.ok || recorded.code === "shipment_already_recorded") {
          await parts.shops.endParcel(parcel.orderId, "shipped", parts.now());
          continue;
        }
        // Nothing answered, or the payment is still settling, which the
        // gateway asks to be called again after.
        if (recorded.status === 0 || recorded.code === "settle_in_flight") {
          console.error(`[dashboard] the shipment of ${parcel.orderId} waits: ${recorded.why}`);
          continue;
        }
        await parts.shops.endParcel(parcel.orderId, "closed", parts.now());
        console.error(
          `[dashboard] the gateway refused the shipment of ${parcel.orderId}` +
            ` (${recorded.code ?? recorded.status}): ${recorded.why}`,
        );
      }
    } catch (thrown) {
      console.error(
        `[dashboard] the parcels of ${connection.accountId} could not be followed this time`,
        thrown,
      );
    }
  }
};

/**
 * How often every placed parcel is read again.
 *
 * A parcel ships in days, and the agent learns of it within minutes of the
 * merchant marking it Completed. Every pass is one read per parcel waiting,
 * against the merchant's own shop, so it is not made more often than that.
 */
const SHIPMENTS_EVERY_MS = 5 * 60_000;

/**
 * How long a placed parcel is read for: thirty days, the longest time to ship
 * any card may name (ADR-0033). A parcel from this connector is past its seven
 * days long before, and a shipment the merchant records late still closes a
 * refund owed while the refund is unpaid (ADR-0028); after thirty days the shop
 * is not read for it again.
 */
const FOLLOWED_FOR_MS = 30 * 24 * 60 * 60 * 1_000;

/** A worker turning, until it is stopped. */
export interface WooWorker {
  stop(): Promise<void>;
}

/** How long the loop waits before looking for connections again. */
const BETWEEN_TURNS_MS = 1_000;

/**
 * Keeps every connected shop's orders being filled, for as long as the dashboard
 * is running.
 *
 * One loop per connected shop rather than one loop walking them all, because
 * the walk is what turns a second merchant into a wait: a poll holds its
 * request open, and a synchronous purchase is answered inside a budget that is
 * the same for every product on the platform. A merchant whose orders were
 * behind somebody else's poll would sell less the more shops we connected.
 *
 * The list of connections is read again every second, so a shop connected while
 * this is running starts being served without a restart and one disconnected
 * stops. Nothing here is a schedule anything depends on: an order nobody draws
 * is handed over again by the order machine, so a dashboard that was down comes
 * back to work that is still waiting.
 */
export const startWooWorker = (
  parts: WorkingParts & { readonly betweenTurnsMs?: number; readonly shipmentsEveryMs?: number },
): WooWorker => {
  const turning = new Map<string, { stop: () => void; done: Promise<void> }>();
  let running = true;

  const loopFor = (accountId: string) => {
    let alive = true;
    const done = (async () => {
      while (alive && running) {
        try {
          const connection = await parts.shops.connectionOf(accountId);
          if (connection === null) {
            // Waited out rather than returned from, which is not tidiness. The
            // watcher below starts a loop for an account that has none, and it
            // decides that by asking whether this map holds one — so a loop
            // that ended on its own would leave an entry nothing is running
            // behind, and a merchant who disconnected and connected again
            // inside one pass would have their orders filled by nobody until
            // the dashboard was restarted. Ending a loop is the watcher's, and
            // it is the only thing that takes the entry away with it.
            await new Promise((resolve) =>
              setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS),
            );
            continue;
          }
          const filled = await turnOnce(connection, parts);
          if (filled === 0) {
            // A turn that drew nothing waits before the next one. The poll
            // ordinarily holds its own request open for seconds, so this is
            // usually zero extra waiting — but a gateway that answers a poll
            // at once, because it refused it or because the wait was asked for
            // as nothing, would otherwise be asked again as fast as this
            // process can ask, which is a dashboard hammering a gateway that is
            // already having a bad afternoon. A turn that did fill something
            // comes straight back, because there may be more waiting.
            await new Promise((resolve) =>
              setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS),
            );
          }
        } catch (thrown) {
          // A turn that threw must not take the loop with it: what is on the
          // other end is somebody else's shop and somebody else's network.
          console.error(`[dashboard] a WooCommerce turn failed for ${accountId}`, thrown);
          await new Promise((resolve) =>
            setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS),
          );
        }
      }
    })();
    return {
      stop: () => {
        alive = false;
      },
      done,
    };
  };

  const watching = (async () => {
    while (running) {
      try {
        const connections = await parts.shops.connections();
        const wanted = new Set(connections.map((one) => one.accountId));
        for (const accountId of wanted) {
          if (!turning.has(accountId)) {
            turning.set(accountId, loopFor(accountId));
          }
        }
        for (const [accountId, loop] of turning) {
          if (!wanted.has(accountId)) {
            loop.stop();
            turning.delete(accountId);
          }
        }
      } catch (thrown) {
        console.error("[dashboard] the WooCommerce worker could not read its connections", thrown);
      }
      await new Promise((resolve) => setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS));
    }
  })();

  // Its own loop, never a step of a shop's turn: a turn answers price
  // questions inside seconds, and reading every waiting parcel of a slow shop
  // would hold those up.
  let wake: (() => void) | null = null;
  const following = (async () => {
    while (running) {
      try {
        await followShipments(parts);
      } catch (thrown) {
        console.error("[dashboard] the parcels could not be followed this time", thrown);
      }
      // A stop that came during the pass found nothing to wake.
      if (!running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, parts.shipmentsEveryMs ?? SHIPMENTS_EVERY_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  })();

  return {
    async stop() {
      running = false;
      (wake as (() => void) | null)?.();
      for (const loop of turning.values()) {
        loop.stop();
      }
      await following;
      await watching;
      await Promise.all([...turning.values()].map((loop) => loop.done));
      turning.clear();
    },
  };
};
