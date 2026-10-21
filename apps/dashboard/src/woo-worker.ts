/**
 * A merchant who connected a shop wrote no code, so the dashboard stands in as
 * their handler: it draws their stream and answers with the calls any
 * merchant's worker makes, in-process, as the merchant on the account that
 * connected the shop. An order this leaves unanswered is handed over again by
 * the order machine, which alone knows how many attempts are left; so the
 * answers are a delivery, a refusal, or nothing, and nothing means "ask me
 * again".
 *
 * A merchant's shop is not ours to write to twice. Delivery is at least once,
 * and a second order in somebody's shop is a second parcel packed for one
 * payment. The ledger in `woo-shops.ts` is claimed before the shop is called
 * and completed after, and an attempt that called and never learned the outcome
 * is refused rather than retried, in words that say it is not knowable from
 * here: "I do not know whether there is an order" is not "there is no order".
 */

import { createHash } from "node:crypto";
import { failureNamed } from "@agentify/gateway/failure-named";
import {
  type HandlerAnswer,
  localityOf,
  type Order,
  type QuoteRequest,
  type QuoteResponse,
  type ShipToLocality,
  ShipToSchema,
  type WorkerEnvelope,
} from "@nuanu-ai/agentify-contracts";
import type { Acting, GatewayClient } from "./gateway.js";
import type { Identity } from "./identity.js";
import { amountOfCents, centsOf, productIdFromMerchantItem } from "./woo-catalog.js";
import {
  type CartPrice,
  createTheOrderInTheShop,
  createTheParcelInTheShop,
  type EligibleWooProduct,
  inspectProductInTheShop,
  type NotSellable,
  type OrderMade,
  type PaidIntoSplit,
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

/**
 * A shop as a log line names it. Its address is kept as the merchant typed it,
 * where a newline the URL parser drops without a word is still in the text.
 */
const shopNamed = (shopUrl: string): string => new URL(shopUrl).origin;

export interface Filling {
  readonly shops: WooShops;
  readonly now: () => Date;
  /**
   * Injectable so this file's decisions can be tested without a WooCommerce; a
   * deployment passes nothing.
   */
  readonly placeOrder?: (keys: ShopKeys, sold: SoldItem) => Promise<OrderMade>;
  /**
   * A price question and an order read the product the same way. A deployment
   * passes nothing.
   */
  readonly inspectProduct?: (
    connection: WooConnection,
    merchantItemId: string,
  ) => Promise<ProductInspection>;
  /** The shop's own cart by default; a deployment passes nothing. */
  readonly shippingRates?: (
    connection: WooConnection,
    productId: string,
    place: ShipToLocality,
  ) => Promise<RatesRead>;
  /** A deployment passes nothing. */
  readonly quoteWithinMs?: number;
  /** A deployment passes nothing. */
  readonly placeParcel?: (keys: ShopKeys, sold: ParcelSold) => Promise<ParcelMade>;
  /** Test seam for the durable quote binding; production reads `WooShops`. */
  readonly quotedProduct?: (
    connection: WooConnection,
    priceId: string,
    merchantItemId: string,
  ) => Promise<string | null>;
}

/**
 * One paid order drawn off the stream, filled from the shop with the split
 * its payment was checked against, read as the merchant. Null where that
 * cannot be read, as where the shop does not answer: a shop order made
 * without it would say no commission was taken.
 */
export const filledAsPaid = async (
  gateway: Pick<GatewayClient, "paidInto">,
  order: Order,
  connection: WooConnection,
  orderEmail: string,
  parts: Filling,
): Promise<HandlerAnswer | null> => {
  const paid = await gateway.paidInto(order.id);
  if (!paid.ok) {
    console.error(
      `[dashboard] where the payment for ${order.id} went could not be read, so the shop is not asked yet: ${paid.why}`,
    );
    return null;
  }
  return await fillFromTheShop(order, connection, orderEmail, parts, paid.document);
};

/**
 * Null is not a failure to decide: the shop did not answer, nothing about the
 * sale is settled, and a refusal would close for good something that might go
 * through a minute later. `paidInto` is the split the order's payment was
 * checked against, which the shop's order names.
 */
export const fillFromTheShop = async (
  order: Order,
  connection: WooConnection,
  orderEmail: string,
  parts: Filling,
  paidInto: PaidIntoSplit | null,
): Promise<HandlerAnswer | null> => {
  // Only a parcel's order carries where it goes.
  if (order.ship_to !== undefined) {
    return await fillParcelFromTheShop(order, connection, orderEmail, parts, paidInto);
  }
  const place = parts.placeOrder ?? createTheOrderInTheShop;
  const known = await parts.shops.knownOrder(order.id);
  if (known?.kind === "placed") {
    return { delivered: deliveryFromWooPermission(known.permission) };
  }
  if (known?.kind === "placed_parcel") {
    // A download's order bound as a parcel's cannot be written by anything
    // here; it is never ordered a second time.
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
    // changed product that caused this refusal; with no accepted quote no
    // fingerprint can satisfy recovery.
    productFingerprint: quoted ?? "unbound-price-id",
    amount: order.price.amount,
    currency: order.price.currency,
  };
  if (eligible === null) {
    await parts.shops.recordPrecreateRefusal(connection.accountId, order.id, facts, parts.now());
    // Refused either way, with the true reason: a shop that did not answer, or
    // whose answer could not be read, has said nothing about the product.
    const silent = !inspected.ok && inspected.again;
    const cutOff = !inspected.ok && inspected.again && inspected.cutOff === true;
    const unread = !inspected.ok && !inspected.again && !inspected.saidNo;
    if (!inspected.ok && unread) unreadable(order.id, inspected.why);
    return {
      refused: {
        code: "cannot_fulfill",
        message: cutOff
          ? "The shop's answer to the product check broke off and could not be read when this" +
            " order was placed, so no WooCommerce order was created."
          : silent
            ? "The shop did not answer when this order was placed, so no WooCommerce order was created."
            : unread
              ? UNREADABLE_PRODUCT
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
    // The shop granted less than asked, so every sale on this connection ends
    // here. The merchant is told which, in their log and on their connection
    // screen; the agent only the fact, since the grant is nothing it could act
    // on.
    console.error(
      `[dashboard] the shop at ${shopNamed(connection.shopUrl)} granted ${JSON.stringify(connection.permissions)}` +
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
    // The same sale handed over again: the shop already has the order, and the
    // buyer gets the same number.
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
    // The merchant's own address, not the buyer's: creating an order makes
    // WooCommerce mail whatever address is on it, and nothing in the request
    // can stop that.
    email: orderEmail,
    price: { amount: order.price.amount, currency: order.price.currency },
    download: { id: eligible.downloadId, name: eligible.fileName },
    paidInto,
    tax: eligible.tax,
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
    // shop, so the next attempt must meet "we do not know" rather than a clean
    // slate.
    console.error(`[dashboard] ${order.id} has no usable WooCommerce creation result`);
    return null;
  }

  // A response after POST is not proof the shop did not commit, so the
  // obligation stays `create_unknown` and needs exact-id recovery, rather than
  // turning a rewritten 4xx into a second POST.
  console.error(`[dashboard] ${order.id} has no verifiable WooCommerce creation result`);
  return unknownCreation(order.id, connection.shopUrl, parts.now());
};

type EligibleParcel = Extract<EligibleWooProduct, { readonly kind: "parcel" }>;

/**
 * What a parcel from a shop that calculates tax sells at: its cart's whole
 * price for the place, at which the order made for that place charges the
 * same, so long as the cart holds the goods at the product's own price, which
 * a plugin changing prices in the cart alone would not leave in the order.
 * A shop whose prices hold their tax may keep one gross price for every
 * buyer, which its cart shows and its order, taxing the place at its own rate,
 * does not; so such a shop's parcel sells only to a place whose cart charges
 * the goods at the entered price under the same taxes as a cart at the shop's
 * own address, and that cart unread or answering otherwise sells nothing.
 */
const taxedParcelPrice = (
  product: EligibleParcel,
  at: Extract<RatesRead, { readonly ok: true }>,
  atBase: RatesRead | null,
): CartPrice | NotSellable => {
  if (!at.priced.ok) return at.priced;
  const otherGoods: NotSellable = {
    ok: false,
    why: "the shop's cart holds the goods at another price than the product's own",
    again: false,
    saidNo: true,
  };
  if (product.tax.mode !== "included") {
    return at.priced.goodsBeforeTax === product.price.amount ? at.priced : otherGoods;
  }
  if (atBase === null) {
    return { ok: false, why: "the shop's own address was not asked", again: false, saidNo: false };
  }
  if (!atBase.ok) return atBase;
  if (!atBase.priced.ok) return atBase.priced;
  const base = atBase.priced;
  const place = at.priced;
  if (place.goods !== product.price.amount) return otherGoods;
  if (
    place.taxes.length !== base.taxes.length ||
    place.taxes.some((tax, index) => tax !== base.taxes[index])
  ) {
    return {
      ok: false,
      why: "the shop taxes this place otherwise than its own address, where its order would not charge what its cart does",
      again: false,
      saidNo: true,
    };
  }
  return place;
};

/**
 * The product is held to the one the price was bound to. Where the shop
 * calculates no tax, the shipping is held to what was paid above the goods:
 * the cart is asked again for the paid-for place, and the rate costing exactly
 * that difference is the one sold. Where it calculates tax, the cart's whole
 * price for the place, asked again, must be what was paid, and its cheapest
 * rate is the one sold. Otherwise the order is refused before anything
 * reaches the shop, and is a unfulfilled order.
 *
 * A shop that does not answer is not a refusal: a parcel has days to ship, so
 * the order comes round again and nothing is written until the shop says
 * something. Once the shop shows the order with the address on it, `accepted`
 * lets Agentify erase its copy; the address is never written to the ledger or
 * the log.
 */
const fillParcelFromTheShop = async (
  order: Order,
  connection: WooConnection,
  orderEmail: string,
  parts: Filling,
  paidInto: PaidIntoSplit | null,
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
  const askRates = (where: ShipToLocality) =>
    (
      parts.shippingRates ??
      ((keys: WooConnection, id: string, at: ShipToLocality) =>
        shippingRatesInTheShop(keys.shopUrl, id, at))
    )(connection, productId, where);
  const inspection = productInTheShop(connection, order.merchant_item_id, parts);
  const [inspected, rates, atBase] = await Promise.all([
    inspection,
    askRates(localityOf(address.data)),
    inspection.then((read) => {
      const base = baseOf(read);
      return base === null ? null : askRates(base);
    }),
  ]);
  if (!inspected.ok && inspected.again) {
    console.error(`[dashboard] ${order.id} waits: ${inspected.why}`);
    return null;
  }
  if (!inspected.ok && !inspected.saidNo) {
    unreadable(order.id, inspected.why);
    return await refuse(UNREADABLE_PRODUCT);
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
  if (!rates.ok) {
    if (!rates.saidNo) {
      unreadable(order.id, rates.why);
      return await refuse(
        "The shop's cart answered about shipping to this place in a way that could not be read or" +
          " trusted, so no WooCommerce order was created.",
      );
    }
    return await refuse(
      "The shop's cart offered no shipping to this place that this sale can be filled at, so no" +
        " WooCommerce order was created.",
    );
  }
  let rate: ShippingRate | undefined;
  if (product.tax.mode === "off") {
    if (rates.rates.some((one) => one.tax !== "0.00")) {
      return await refuse(
        "The shop's cart offered no shipping to this place that this sale can be filled at, so no" +
          " WooCommerce order was created.",
      );
    }
    const goods = centsOf(product.price.amount);
    const paid =
      order.price.currency === product.price.currency ? centsOf(order.price.amount) : null;
    rate =
      goods === null || paid === null
        ? undefined
        : rates.rates.find((one) => centsOf(one.cost) === paid - goods);
  } else {
    const priced = taxedParcelPrice(product, rates, atBase);
    if (!priced.ok && priced.again) {
      console.error(`[dashboard] ${order.id} waits: ${priced.why}`);
      return null;
    }
    if (!priced.ok && !priced.saidNo) {
      unreadable(order.id, priced.why);
      return await refuse(
        "The shop's cart answered about shipping to this place in a way that could not be read or" +
          " trusted, so no WooCommerce order was created.",
      );
    }
    if (!priced.ok) {
      console.error(`[dashboard] ${order.id} is refused: ${priced.why}`);
      return await refuse(
        "The shop's cart offered no price for this place that this sale can be filled at, so no" +
          " WooCommerce order was created.",
      );
    }
    rate =
      priced.total === order.price.amount && order.price.currency === product.price.currency
        ? priced.rate
        : undefined;
  }
  if (rate === undefined) {
    return await refuse(
      "The shop's shipping to this place no longer costs what was paid for it, so no WooCommerce order was created.",
    );
  }
  if (connection.permissions !== "read_write") {
    console.error(
      `[dashboard] the shop at ${shopNamed(connection.shopUrl)} granted ${JSON.stringify(connection.permissions)}` +
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
    paidInto,
    tax: product.tax.mode,
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
      `[dashboard] ${order.id} was created in WooCommerce as order ${made.id} but was not durably bound`,
    );
    return null;
  }
  // From here the shop may hold a paid order while the sale is refused and remains
  // unfulfilled, so the log names the shop's order, where known, as one not to
  // ship.
  const inTheShop =
    made.id === undefined
      ? ""
      : `; the shop's order ${made.id} does not match it and is not to be shipped`;
  if (made.again) {
    // Not answered, and the claim stays: the order may be in the shop.
    console.error(`[dashboard] ${order.id} has no usable WooCommerce creation result${inTheShop}`);
    return null;
  }
  console.error(
    `[dashboard] ${order.id} has no verifiable WooCommerce creation result${inTheShop}`,
  );
  return unknownCreation(order.id, connection.shopUrl, parts.now());
};

const UNREADABLE_PRODUCT =
  "The shop's answer to the product check could not be read or trusted when this order was" +
  " placed, so no WooCommerce order was created.";

/**
 * The buyer is told only that the answer could not be read. Why goes to the
 * dashboard's own log, which the operator reads and the merchant cannot; a
 * reason carries no address.
 */
const unreadable = (orderId: string, why: string): void => {
  console.error(`[dashboard] ${orderId} is refused, the shop's answer unread: ${why}`);
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
    `[dashboard] ${orderId} was already being placed in the shop at ${shopNamed(shopUrl)} at` +
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

export interface WorkingParts extends Filling {
  readonly identity: Pick<Identity, "byId">;
  readonly clientFor: (acting: Acting) => GatewayClient;
  readonly waitSeconds?: number;
  /** The real read by default; a deployment passes nothing. */
  readonly readShipment?: (
    keys: ShopKeys,
    wooOrderId: string,
    orderId: string,
  ) => Promise<ShipmentRead>;
}

/**
 * Short enough not to hold up a stopping dashboard, long enough to pick up a
 * synchronous order at once, while its agent holds a request open.
 */
const WAIT_SECONDS = 5;

/**
 * Returns how many envelopes were drawn, events included, which the loop reads
 * to decide whether to come straight back: one envelope per poll, so a turn
 * that drew an event is not a quiet stream.
 */
type ScheduleEnvelope = (envelope: WorkerEnvelope, answer: () => Promise<void>) => Promise<void>;

export const turnOnce = async (
  connection: WooConnection,
  parts: WorkingParts,
  schedule: ScheduleEnvelope = async (_envelope, answer) => answer(),
): Promise<number> => {
  const person = await parts.identity.byId(connection.accountId);
  if (person === null || person.merchant === null) {
    // The account is gone or has no merchant; nothing can be drawn as nobody.
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
    await schedule(envelope, async () => {
      if (envelope.kind === "quote_request") {
        const answer =
          connection.permissions !== "read_write"
            ? { available: false as const, as_of: parts.now().toISOString() }
            : await quoteFromTheShop(connection, envelope.payload, parts.now(), parts);
        if (answer === null) {
          // Saying nothing is how the gateway hears that the shop did not answer;
          // the agent is told the price check went unanswered.
          return;
        }
        const said = await gateway.answerQuote(envelope.payload.price_id, answer);
        if (!said.ok) {
          console.error(
            `[dashboard] the price answer for ${envelope.payload.price_id} was not accepted: ${said.why}`,
          );
        }
        return;
      }
      // Events have no reply.
      if (envelope.kind !== "order") {
        return;
      }
      const answer = await filledAsPaid(gateway, envelope.payload, connection, person.email, parts);
      if (answer === null) {
        return;
      }
      const said = await gateway.answerOrder(envelope.payload.id, answer);
      if (!said.ok) {
        console.error(
          `[dashboard] the answer for ${envelope.payload.id} was not accepted: ${said.why}`,
        );
      }
    });
  }
  return drawn.document.envelopes.length;
};

/**
 * The gateway waits five seconds for a price (`QUOTE_RESPONSE_MS`) and then
 * reads the merchant as silent; four leaves time for the answer to travel and
 * keeps a slow shop from holding up the work queued behind it.
 */
const QUOTE_WITHIN_MS = 4_000;

/** Null where it did not finish in time. */
const inTime = async <T>(work: Promise<T>, ms: number): Promise<T | null> => {
  let cut: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    cut = setTimeout(() => resolve(null), ms);
  });
  // A late answer answers nobody and must not surface as a failure of the turn
  // that stopped waiting.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(cut);
  }
};

/** Null where there is none. */
const cheapestCents = (rates: readonly ShippingRate[]): bigint | null => {
  let cheapest: bigint | null = null;
  for (const rate of rates) {
    const cost = centsOf(rate.cost);
    if (cost !== null && (cheapest === null || cost < cheapest)) cheapest = cost;
  }
  return cheapest;
};

/**
 * The product is bound to the price so the order paying it can be held to it. A
 * parcel's price is the goods plus the shop's cheapest rate to the asked-for
 * place, added in cents; the rate is not bound, because it says where the buyer
 * is and a binding is kept for good, so the order asks the shop again.
 *
 * A price already bound to another product is not moved: the order is held to
 * what it was first bound to, so a second answer naming different goods would
 * be a price no order could be filled against.
 */
export const quoteFromTheShop = async (
  connection: WooConnection,
  question: QuoteRequest,
  at: Date,
  parts: Filling,
): Promise<QuoteResponse | null> => {
  const unavailable: QuoteResponse = { available: false, as_of: at.toISOString() };
  /** The reason goes to the merchant's log, with no word of the place. */
  const unpriced = (why: string): QuoteResponse => {
    console.error(
      `[dashboard] ${question.merchant_item_id} has no price for ${question.price_id}: ${why}`,
    );
    return unavailable;
  };
  const productId = productIdFromMerchantItem(connection.shopUrl, question.merchant_item_id);
  const place = question.ship_to;
  const askRates = (where: ShipToLocality) =>
    productId === null
      ? Promise.resolve(null)
      : (
          parts.shippingRates ??
          ((keys: WooConnection, id: string, at: ShipToLocality) =>
            shippingRatesInTheShop(keys.shopUrl, id, at))
        )(connection, productId, where);
  // Asked together with the product, because both must fit in the time a price
  // question has; the shop's own address as soon as the product check names it.
  const inspection = productInTheShop(connection, question.merchant_item_id, parts);
  const read = await inTime(
    Promise.all([
      inspection,
      place === undefined ? Promise.resolve(null) : askRates(place),
      inspection.then((answer) => {
        const base = baseOf(answer);
        return base === null || place === undefined ? null : askRates(base);
      }),
    ]),
    parts.quoteWithinMs ?? QUOTE_WITHIN_MS,
  );
  // "Not available" is the seller's no, so it is said only where the shop's
  // own readable answer ruled the sale out. A shop that did not answer, or
  // whose answer could not be read or trusted, said nothing: null lets the
  // gateway's wait run out and tells the agent the price check went
  // unanswered. On a WooCommerce card (asynchronous or a parcel) that silence
  // refuses the sale; on a `sync` or a `confirm` card it would sell at
  // the listed price instead.
  const silent = (why: string): null => {
    console.error(
      `[dashboard] ${question.merchant_item_id} is not priced for ${question.price_id}, and nothing is said: ${why}`,
    );
    return null;
  };
  if (read === null) return silent("the shop did not answer in time");
  const [inspected, rates, atBase] = read;
  if (!inspected.ok) {
    return inspected.again || !inspected.saidNo ? silent(inspected.why) : unavailable;
  }
  const product = inspected.product;
  // A question with a place is a parcel's card, and the goods alone are not a
  // price it can be sold at.
  if (place !== undefined && product.kind !== "parcel") {
    return unpriced("the product in the shop is no longer a parcel");
  }
  let price = product.price;
  if (product.kind === "parcel") {
    if (rates === null) return unpriced("the question carries no place to ship to");
    if (!rates.ok) return rates.again || !rates.saidNo ? silent(rates.why) : unpriced(rates.why);
    if (product.tax.mode === "off") {
      // Such a shop's order carries no tax, so no rate that does is a price.
      if (rates.rates.some((one) => one.tax !== "0.00")) {
        return unpriced("the shop calculates no tax, and its cart taxes the shipping rate");
      }
      const goods = centsOf(product.price.amount);
      const carriage = cheapestCents(rates.rates);
      if (goods === null || carriage === null) {
        return unpriced("the shop has no shipping rate to that place");
      }
      price = { amount: amountOfCents(goods + carriage), currency: product.price.currency };
    } else {
      const priced = taxedParcelPrice(product, rates, atBase);
      if (!priced.ok) {
        return priced.again || !priced.saidNo ? silent(priced.why) : unpriced(priced.why);
      }
      price = { amount: priced.total, currency: product.price.currency };
    }
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

/** Where an inclusive shop's parcel is also asked about: the shop's own address. */
const baseOf = (inspected: ProductInspection): ShipToLocality | null =>
  inspected.ok && inspected.product.kind === "parcel" && inspected.product.tax.mode === "included"
    ? inspected.product.tax.base
    : null;

/** Read the one way both answers read it. */
const productInTheShop = (
  connection: WooConnection,
  merchantItemId: string,
  parts: Filling,
): Promise<ProductInspection> =>
  (parts.inspectProduct ?? inspectProductInTheShop)(connection, merchantItemId);

/**
 * A parcel marked Completed is recorded with the gateway as shipped, the last
 * thing the agent hears, and is followed no further. One the shop ended without
 * completing is let go without a word to the gateway: it never shipped, and its
 * time to ship running out makes it a unfulfilled order. A gateway that did not
 * answer is asked again next pass; a refused shipment is in the merchant's log.
 *
 * Shops are read one after another, and one that throws is skipped for this
 * pass so it cannot keep another merchant's parcels from shipping.
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
              " it is followed no further and becomes an unfulfilled order when its time to ship runs out",
          );
          continue;
        }
        const recorded = await gateway.deliverOrder(parcel.orderId, said.shipment);
        if (recorded.ok || recorded.code === "shipment_already_recorded") {
          await parts.shops.endParcel(parcel.orderId, "shipped", parts.now());
          continue;
        }
        // Nothing answered, or the payment is still settling, which the gateway
        // asks to be called again after.
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
        `[dashboard] the parcels of ${connection.accountId} could not be followed this time: ${failureNamed(thrown)}`,
      );
    }
  }
};

/**
 * Each pass is one read per waiting parcel against the merchant's own shop; the
 * agent still learns of a shipment within minutes.
 */
const SHIPMENTS_EVERY_MS = 5 * 60_000;

/**
 * Thirty days, the longest time to ship any card may name. A shipment recorded
 * late still closes a unfulfilled order until the merchant closes Agentify fulfillment.
 */
const FOLLOWED_FOR_MS = 30 * 24 * 60 * 60 * 1_000;

export interface WooWorker {
  stop(): Promise<void>;
}

const BETWEEN_TURNS_MS = 1_000;
// shortcut: four unfinished envelopes per shop; revisit on measured saturation.
const HANDLERS_AT_ONCE = 4;

/**
 * One loop per connected shop, because a poll holds its request open and a
 * synchronous purchase has a fixed budget; walking shops in one loop would make
 * each merchant wait behind the others.
 *
 * Connections are reread every second, so shops connected or disconnected while
 * running are picked up without a restart. Nothing depends on this as a
 * schedule: an order nobody draws is handed over again by the order machine.
 */
export const startWooWorker = (
  parts: WorkingParts & { readonly betweenTurnsMs?: number; readonly shipmentsEveryMs?: number },
): WooWorker => {
  const turning = new Map<string, { stop: () => boolean; done: Promise<void> }>();
  let running = true;

  const loopFor = (accountId: string) => {
    let alive = true;
    const active = new Set<Promise<void>>();
    const orders = new Set<string>();
    let wakeRoom: (() => void) | undefined;
    const room = async () => {
      while (alive && running && active.size >= HANDLERS_AT_ONCE) {
        await new Promise<void>((resolve) => {
          wakeRoom = resolve;
        });
        wakeRoom = undefined;
      }
    };
    const schedule: ScheduleEnvelope = async (envelope, answer) => {
      await room();
      if (!alive || !running) return;
      if (envelope.kind === "order" && orders.has(envelope.payload.id)) return;
      if (envelope.kind === "order") orders.add(envelope.payload.id);
      const work = Promise.resolve()
        .then(answer)
        .catch((thrown: unknown) => {
          console.error(
            `[dashboard] a WooCommerce turn failed for ${accountId}: ${failureNamed(thrown)}`,
          );
        })
        .finally(() => {
          active.delete(work);
          wakeRoom?.();
          if (envelope.kind === "order") orders.delete(envelope.payload.id);
        });
      active.add(work);
    };
    const done = (async () => {
      while (alive && running) {
        try {
          await room();
          if (!alive || !running) break;
          const connection = await parts.shops.connectionOf(accountId);
          if (!alive || !running) break;
          if (connection === null) {
            // Waited out rather than returned from: the watcher starts a loop
            // for an account whose entry is missing from this map, so a loop
            // that ended on its own would leave an entry with nothing behind
            // it, and a quick disconnect and reconnect would go unserved until
            // restart. Only the watcher ends a loop and removes its entry.
            await new Promise((resolve) =>
              setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS),
            );
            continue;
          }
          const filled = await turnOnce(connection, parts, schedule);
          if (filled === 0) {
            // A turn that drew nothing waits, so a gateway answering polls at
            // once (refused, or a zero wait) is not hammered; a turn that
            // filled something comes straight back.
            await new Promise((resolve) =>
              setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS),
            );
          }
        } catch (thrown) {
          // A turn that threw must not take the loop with it: the other end is
          // somebody else's shop and network.
          console.error(
            `[dashboard] a WooCommerce turn failed for ${accountId}: ${failureNamed(thrown)}`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS),
          );
        }
      }
      await Promise.all(active);
    })();
    return {
      stop: () => {
        if (!alive) return false;
        alive = false;
        wakeRoom?.();
        return true;
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
          if (!wanted.has(accountId) && loop.stop()) {
            // Reconnect must wait for the old poll and accepted work to finish.
            void loop.done.then(() => {
              if (turning.get(accountId) === loop) turning.delete(accountId);
            });
          }
        }
      } catch (thrown) {
        console.error(
          `[dashboard] the WooCommerce worker could not read its connections: ${failureNamed(thrown)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, parts.betweenTurnsMs ?? BETWEEN_TURNS_MS));
    }
  })();

  // Its own loop, so reading a slow shop's parcels never holds up the price
  // questions a turn answers within seconds.
  let wake: (() => void) | null = null;
  const following = (async () => {
    while (running) {
      try {
        await followShipments(parts);
      } catch (thrown) {
        console.error(
          `[dashboard] the parcels could not be followed this time: ${failureNamed(thrown)}`,
        );
      }
      // A stop during the pass found nothing to wake.
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
