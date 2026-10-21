/**
 * Deliberately not a scanner. A definite refusal before the order was created
 * may make one POST after the merchant reconnects the same shop; an uncertain
 * create may only bind the exact WooCommerce order id its merchant supplied and
 * verified.
 */

import { createHash } from "node:crypto";
import type { Delivery, OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import type { Person } from "./dashboard-entry.js";
import type { Acting, GatewayClient } from "./gateway.js";
import {
  createTheOrderInTheShop,
  inspectProductInTheShop,
  type OrderMade,
  type PaidIntoSplit,
  type ProductInspection,
  readTheOrderInTheShop,
  type ShopKeys,
  type SoldItem,
  type WooOrderLookup,
  type WooOrderRead,
} from "./woo-shop.js";
import type { WooConnection, WooOrderFacts, WooPermission, WooShops } from "./woo-shops.js";
import { deliveryFromWooPermission } from "./woo-worker.js";

export interface WooRecoveryRequest {
  readonly orderId: string;
  readonly wooOrderId?: string;
}

export type WooRecoveryOutcome =
  | Readonly<{ ok: true; state: "delivered"; orderId: string; wooOrderId: string }>
  | Readonly<{
      ok: false;
      state: "refused" | "unresolved";
      why: string;
      /** Set where the refusal is about the WooCommerce order ID the merchant typed. */
      typed?: true;
    }>;

type MakeOrder = (keys: ShopKeys, sold: SoldItem) => Promise<OrderMade>;

export type RecoveryGateway = Pick<GatewayClient, "getOrder" | "deliverOrder" | "paidInto">;

export interface WooRecoveryParts {
  readonly shops: WooShops;
  readonly identity: { byId(personId: string): Promise<Person | null> };
  readonly gatewayFor: (acting: Acting) => RecoveryGateway;
  readonly inspectProduct?: (keys: ShopKeys, itemId: string) => Promise<ProductInspection>;
  /** The operator's command alone creates a shop order; the shop's own creation is the default. */
  readonly createOrder?: MakeOrder;
  readonly readOrder?: (keys: ShopKeys, wooOrderId: string) => Promise<WooOrderLookup>;
  readonly now: () => Date;
}

export type MerchantWooRecoveryParts = Omit<WooRecoveryParts, "identity" | "createOrder">;

/** Ownership is established before disclosing sale details or acting as its merchant. */
const CANNOT_CREATE =
  "This recovery links an existing shop order or retries a saved delivery. It cannot create a shop order.";

export const ownWooRecoveryOrder = async (person: Person, orderId: string, shops: WooShops) => {
  const record = await shops.recoveryOrder(orderId);
  return person.merchant !== null && record?.accountId === person.id ? record : null;
};

export const recoverWooOrderAs = async (
  person: Person,
  request: WooRecoveryRequest,
  parts: MerchantWooRecoveryParts,
): Promise<WooRecoveryOutcome> => {
  const record = await ownWooRecoveryOrder(person, request.orderId, parts.shops);
  if (record === null) return refused("No recoverable WooCommerce order has that id.");
  if (record.phase === "precreate_refused") return refused(CANNOT_CREATE);
  if (request.wooOrderId !== undefined && !/^[1-9][0-9]*$/.test(request.wooOrderId)) {
    return typedWrong("Enter the exact numeric WooCommerce order ID.");
  }
  return recover(record, person, request, parts, undefined);
};

export const recoverWooOrder = async (
  request: WooRecoveryRequest,
  parts: WooRecoveryParts,
): Promise<WooRecoveryOutcome> => {
  const record = await parts.shops.recoveryOrder(request.orderId);
  if (record === null) return refused("No recoverable WooCommerce order has that id.");
  const person = await parts.identity.byId(record.accountId);
  if (person === null || person.merchant === null) {
    return refused("The WooCommerce order no longer belongs to a merchant account.");
  }
  return recover(record, person, request, parts, parts.createOrder ?? createTheOrderInTheShop);
};

/**
 * `create` is absent on the merchant's path, so a sale its shop was never
 * asked to create stays refused there even past the check that turns it away
 * before any call.
 */
const recover = async (
  record: NonNullable<Awaited<ReturnType<WooShops["recoveryOrder"]>>>,
  person: Person,
  request: WooRecoveryRequest,
  parts: Omit<WooRecoveryParts, "identity" | "createOrder">,
  create: MakeOrder | undefined,
): Promise<WooRecoveryOutcome> => {
  if (record.facts.kind === "parcel") {
    // Recovery makes or binds a download's order. A placed parcel is a sale
    // already taken on and followed in its shop; one refused before its order
    // was made has no address left to make one with; one whose order may exist
    // is settled with the merchant in their shop.
    return refused(
      record.phase === "placed"
        ? "This command recovers downloads only. This parcel's WooCommerce order is placed, and" +
            " is read in the shop it was sold from until it is marked Completed, cancelled or" +
            " refunded there, or for thirty days after it was placed."
        : "This command recovers downloads only. A parcel refused before its WooCommerce order was" +
            " made has no address left to make one with; for one whose order may exist, look in" +
            " the shop for an order carrying this identifier as its transaction id, and do not" +
            " ship it, because the Agentify sale is unfulfilled; close fulfillment on Orders instead.",
    );
  }
  if (person.merchant === null) {
    return refused("The WooCommerce order no longer belongs to a merchant account.");
  }
  const gateway = parts.gatewayFor({ merchantId: person.merchant.id, email: person.email });
  const state = await gateway.getOrder(request.orderId);
  if (!state.ok) return unresolved("The Agentify order state could not be read.");
  if (!matchesSavedWooSale(state.document, record.facts, request.orderId)) {
    return refused("The Agentify order does not match the saved WooCommerce sale.");
  }
  if (
    state.document.status !== "unfulfilled" &&
    !(record.phase === "placed" && state.document.status === "delivered")
  ) {
    return refused(
      "Only a paid order still awaiting delivery, or a saved delivery being checked again, can be recovered this way.",
    );
  }

  if (
    request.wooOrderId !== undefined &&
    record.phase !== "create_unknown" &&
    !(record.phase === "placed" && record.placed?.id === request.wooOrderId)
  ) {
    return refused("A WooCommerce order id applies only when creation is uncertain.");
  }

  if (record.phase === "placed") {
    if (record.placed?.permission == null) {
      return unresolved("The saved WooCommerce delivery is incomplete.");
    }
    return deliverSaved(request.orderId, record.placed.id, record.placed.permission, gateway);
  }

  const acceptedFingerprint = await parts.shops.quotedProduct(
    record.accountId,
    record.facts.priceId,
    record.facts.merchantItemId,
  );
  if (acceptedFingerprint === null || acceptedFingerprint !== record.facts.productFingerprint) {
    return refused("The saved WooCommerce sale does not match its accepted price question.");
  }

  const connection = await parts.shops.connectionOf(record.accountId);
  if (connection === null || originOf(connection.shopUrl) !== record.facts.shopOrigin) {
    return refused("Reconnect the same WooCommerce shop before recovery.");
  }

  const inspected = await (parts.inspectProduct ?? inspectProductInTheShop)(
    keysOf(connection),
    record.facts.merchantItemId,
  );
  if (!inspected.ok && inspected.again) {
    return unresolved(
      inspected.cutOff === true
        ? "The shop's answer to the product check broke off and could not be read. Nothing was changed, and the recovery can be run again."
        : "The shop did not answer the product check. Nothing was changed, and the recovery can be run again.",
    );
  }
  if (!inspected.ok && !inspected.saidNo) {
    return unresolved(
      `The shop's answer to the product check could not be read or trusted: ${inspected.why}` +
        " Nothing was changed. If the shop's keys were revoked, connect it again, then run the" +
        " recovery again.",
    );
  }
  if (
    !inspected.ok ||
    inspected.product.kind !== "download" ||
    !sameProduct(inspected.product, record.facts)
  ) {
    return refused("The product no longer matches the accepted WooCommerce sale.");
  }

  if (record.phase === "precreate_refused") {
    if (create === undefined) return refused(CANNOT_CREATE);
    if (request.wooOrderId !== undefined) {
      return refused("No WooCommerce order id is expected for a definite pre-create refusal.");
    }
    if (connection.revision === record.facts.connectionRevision) {
      return refused("Reconnect the same WooCommerce shop before retrying creation.");
    }
    // Read before the claim, so a recovery that cannot say where the payment
    // went can be asked again.
    const paid = await gateway.paidInto(request.orderId);
    if (!paid.ok) {
      return unresolved(
        "Where the sale's payment went could not be read. Nothing was changed, and the recovery can be run again.",
      );
    }
    const claimed = await parts.shops.beginPrecreateRecovery(
      request.orderId,
      connection.revision,
      parts.now(),
    );
    if (!claimed) return unresolved("Another recovery already claimed this order.");
    const made = await create(
      keysOf(connection),
      soldItem(request.orderId, person.email, record.facts, inspected.product, paid.document),
    );
    if (!made.ok) {
      return unresolved(
        "WooCommerce order creation is now uncertain; supply the exact WooCommerce order id after checking the shop.",
      );
    }
    return bindAndDeliver(
      request.orderId,
      permissionFor(connection, made, inspected.product, person.email),
      made.id,
      made.number,
      parts,
      gateway,
    );
  }

  if (request.wooOrderId === undefined) {
    return unresolved("Supply the exact WooCommerce order id after checking the shop.");
  }
  const looked = await (parts.readOrder ?? readTheOrderInTheShop)(
    keysOf(connection),
    request.wooOrderId,
  );
  if (!looked.ok) {
    return unresolved(
      "The exact WooCommerce order could not be verified. Check the shop connection and try this same order ID again.",
    );
  }
  const differences = differencesOf(
    looked.order,
    record.facts,
    person.email,
    request.orderId,
    request.wooOrderId,
  );
  if (differences.length > 0) {
    return typedWrong(`That order does not match this sale: ${differences.join("; ")}.`);
  }
  const permission: WooPermission = {
    shopOrigin: record.facts.shopOrigin,
    productId: record.facts.productId,
    orderKey: looked.order.orderKey,
    downloadId: inspected.product.downloadId,
    fileName: inspected.product.fileName,
    emailUid: emailUid(person.email),
    orderNumber: looked.order.number,
  };
  return bindAndDeliver(
    request.orderId,
    permission,
    looked.order.id,
    looked.order.number,
    parts,
    gateway,
  );
};

const bindAndDeliver = async (
  orderId: string,
  permission: WooPermission,
  wooOrderId: string,
  number: string,
  parts: Omit<WooRecoveryParts, "identity">,
  gateway: RecoveryGateway,
): Promise<WooRecoveryOutcome> => {
  const bound = await parts.shops.recordOrder(
    orderId,
    { id: wooOrderId, number, permission },
    parts.now(),
  );
  if (!bound) {
    const existing = await parts.shops.recoveryOrder(orderId);
    if (
      existing?.phase !== "placed" ||
      existing.placed?.id !== wooOrderId ||
      JSON.stringify(existing.placed.permission) !== JSON.stringify(permission)
    ) {
      return unresolved("The order was bound by another recovery with a different result.");
    }
  }
  return deliverSaved(orderId, wooOrderId, permission, gateway);
};

const deliverSaved = async (
  orderId: string,
  wooOrderId: string,
  permission: WooPermission,
  gateway: RecoveryGateway,
): Promise<WooRecoveryOutcome> => {
  const delivered = await gateway.deliverOrder(
    orderId,
    deliveryFromWooPermission(permission) as Delivery,
  );
  if (!delivered.ok || !delivered.document.ok) {
    return unresolved("Agentify did not confirm the late delivery.");
  }
  const readback = await gateway.getOrder(orderId);
  if (!readback.ok || readback.document.status !== "delivered") {
    return unresolved("The late delivery landed without a delivered readback.");
  }
  return { ok: true, state: "delivered", orderId, wooOrderId };
};

export const matchesSavedWooSale = (
  order: OrderWithStatus,
  facts: WooOrderFacts,
  orderId: string,
): boolean =>
  order.id === orderId &&
  order.merchant_item_id === facts.merchantItemId &&
  order.price_id === facts.priceId &&
  order.price.amount === facts.amount &&
  order.price.currency === facts.currency;

const sameProduct = (
  product: {
    productId: string;
    fingerprint: string;
    price: { amount: string; currency: string };
  },
  facts: WooOrderFacts,
): boolean =>
  product.productId === facts.productId &&
  product.fingerprint === facts.productFingerprint &&
  product.price.amount === facts.amount &&
  product.price.currency === facts.currency;

/** What the merchant can check in their shop, one clause for each fact that differs. */
const differencesOf = (
  order: WooOrderRead,
  facts: WooOrderFacts,
  email: string,
  orderId: string,
  wooOrderId: string,
): string[] => {
  const price = `${facts.amount} ${facts.currency}`;
  return [
    order.id !== wooOrderId || order.orderKey === ""
      ? "the shop answered with a different order"
      : null,
    ["processing", "completed"].includes(order.status)
      ? null
      : `its status is ${order.status}, not Processing or Completed`,
    order.currency === facts.currency &&
    order.total === facts.amount &&
    order.subtotal === facts.amount &&
    order.lineTotal === facts.amount &&
    order.totalTax === "0.00" &&
    order.lineTax === "0.00"
      ? null
      : `its total is not ${price} with no tax`,
    order.paymentMethod === "agentify" ? null : "it was not paid with Agentify",
    order.transactionId === orderId ? null : "its Transaction ID is not this Agentify order ID",
    order.billingEmail === email ? null : `its billing email is not ${email}`,
    order.productId === facts.productId && order.quantity === 1
      ? null
      : "it does not hold exactly one of this product",
    order.agentifyOrderIds.length === 1 && order.agentifyOrderIds[0] === orderId
      ? null
      : "its Agentify order mark is missing or names another order",
  ].filter((clause): clause is string => clause !== null);
};

const soldItem = (
  orderId: string,
  email: string,
  facts: WooOrderFacts,
  product: { downloadId: string; fileName: string },
  paidInto: PaidIntoSplit | null,
): SoldItem => ({
  orderId,
  productId: facts.productId,
  email,
  price: { amount: facts.amount, currency: facts.currency },
  download: { id: product.downloadId, name: product.fileName },
  paidInto,
});

const permissionFor = (
  connection: WooConnection,
  made: Extract<OrderMade, { ok: true }>,
  product: { productId: string; downloadId: string; fileName: string },
  email: string,
): WooPermission => ({
  shopOrigin: originOf(connection.shopUrl),
  productId: product.productId,
  orderKey: made.orderKey,
  downloadId: made.downloadId,
  fileName: product.fileName,
  emailUid: emailUid(email),
  orderNumber: made.number,
});

const keysOf = (connection: WooConnection): ShopKeys => ({
  shopUrl: connection.shopUrl,
  consumerKey: connection.consumerKey,
  consumerSecret: connection.consumerSecret,
});

const originOf = (url: string): string => new URL(url).origin;
const emailUid = (email: string): string => createHash("sha256").update(email).digest("hex");
const refused = (why: string): WooRecoveryOutcome => ({ ok: false, state: "refused", why });
const typedWrong = (why: string): WooRecoveryOutcome => ({
  ok: false,
  state: "refused",
  why,
  typed: true,
});
const unresolved = (why: string): WooRecoveryOutcome => ({ ok: false, state: "unresolved", why });
