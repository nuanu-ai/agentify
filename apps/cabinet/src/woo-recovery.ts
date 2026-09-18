/**
 * One explicit operator recovery for one paid WooCommerce order.
 *
 * This is deliberately not a scanner. A definite pre-create refusal may make
 * one POST after the merchant reconnects the same shop. An uncertain create
 * may only bind the exact Woo order id an operator supplied and verified.
 */

import { createHash } from "node:crypto";
import type { Delivery, OrderCallResponse, OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import type { Person } from "./cabinet-entry.js";
import type { Answer } from "./gateway.js";
import {
  createTheOrderInTheShop,
  inspectProductInTheShop,
  type OrderMade,
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
  | Readonly<{ ok: false; state: "refused" | "unresolved"; why: string }>;

interface RecoveryGateway {
  getOrder(orderId: string): Promise<Answer<OrderWithStatus>>;
  deliverOrder(orderId: string, delivery: Delivery): Promise<Answer<OrderCallResponse>>;
}

export interface WooRecoveryParts {
  readonly shops: WooShops;
  readonly identity: { byId(personId: string): Promise<Person | null> };
  readonly gatewayForKey: (key: string) => RecoveryGateway;
  readonly inspectProduct?: (keys: ShopKeys, itemId: string) => Promise<ProductInspection>;
  readonly createOrder?: (keys: ShopKeys, sold: SoldItem) => Promise<OrderMade>;
  readonly readOrder?: (keys: ShopKeys, wooOrderId: string) => Promise<WooOrderLookup>;
  readonly now: () => Date;
}

export const recoverWooOrder = async (
  request: WooRecoveryRequest,
  parts: WooRecoveryParts,
): Promise<WooRecoveryOutcome> => {
  const record = await parts.shops.recoveryOrder(request.orderId);
  if (record === null) return refused("No recoverable WooCommerce order has that id.");
  const person = await parts.identity.byId(record.accountId);
  if (person?.merchant === null || person === null) {
    return refused("The WooCommerce order no longer belongs to a merchant account.");
  }
  const gateway = parts.gatewayForKey(person.merchant.key);
  const state = await gateway.getOrder(request.orderId);
  if (!state.ok) return unresolved("The Agentify order state could not be read.");
  if (!sameSoldOrder(state.document, record.facts, request.orderId)) {
    return refused("The Agentify order does not match the saved WooCommerce sale.");
  }
  if (
    state.document.status !== "refund_due" &&
    !(record.phase === "placed" && state.document.status === "delivered")
  ) {
    return refused("Only an unpaid delivery debt can be recovered this way.");
  }

  const connection = await parts.shops.connectionOf(record.accountId);
  if (connection === null || originOf(connection.shopUrl) !== record.facts.shopOrigin) {
    return refused("Reconnect the same WooCommerce shop before recovery.");
  }
  if (request.wooOrderId !== undefined && record.phase !== "create_unknown") {
    return refused("A WooCommerce order id applies only when creation is uncertain.");
  }

  if (record.phase === "placed") {
    if (record.placed === null) return unresolved("The saved WooCommerce delivery is incomplete.");
    return deliverSaved(request.orderId, record.placed.id, record.placed.permission, gateway);
  }

  const inspected = await (parts.inspectProduct ?? inspectProductInTheShop)(
    keysOf(connection),
    record.facts.merchantItemId,
  );
  if (!inspected.ok || !sameProduct(inspected.product, record.facts)) {
    return refused("The product no longer matches the accepted WooCommerce sale.");
  }

  if (record.phase === "precreate_refused") {
    if (request.wooOrderId !== undefined) {
      return refused("No WooCommerce order id is expected for a definite pre-create refusal.");
    }
    if (connection.revision === record.facts.connectionRevision) {
      return refused("Reconnect the same WooCommerce shop before retrying creation.");
    }
    const claimed = await parts.shops.beginPrecreateRecovery(
      request.orderId,
      connection.revision,
      parts.now(),
    );
    if (!claimed) return unresolved("Another recovery already claimed this order.");
    const made = await (parts.createOrder ?? createTheOrderInTheShop)(
      keysOf(connection),
      soldItem(request.orderId, person.email, record.facts, inspected.product),
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
  if (
    !looked.ok ||
    !sameWooOrder(looked.order, record.facts, person.email, request.orderId, request.wooOrderId)
  ) {
    return refused("That WooCommerce order does not exactly match this Agentify sale.");
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
  parts: WooRecoveryParts,
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

const sameSoldOrder = (order: OrderWithStatus, facts: WooOrderFacts, orderId: string): boolean =>
  order.id === orderId &&
  order.merchant_item_id === facts.merchantItemId &&
  order.price.amount === facts.amount &&
  order.price.currency === facts.currency;

const sameProduct = (
  product: { productId: string; price: { amount: string; currency: string } },
  facts: WooOrderFacts,
): boolean =>
  product.productId === facts.productId &&
  product.price.amount === facts.amount &&
  product.price.currency === facts.currency;

const sameWooOrder = (
  order: WooOrderRead,
  facts: WooOrderFacts,
  email: string,
  orderId: string,
  wooOrderId: string,
): boolean =>
  order.id === wooOrderId &&
  ["processing", "completed"].includes(order.status) &&
  order.currency === facts.currency &&
  order.total === facts.amount &&
  order.totalTax === "0.00" &&
  order.paymentMethod === "agentify" &&
  order.transactionId === orderId &&
  order.billingEmail === email &&
  order.productId === facts.productId &&
  order.quantity === 1 &&
  order.subtotal === facts.amount &&
  order.lineTotal === facts.amount &&
  order.lineTax === "0.00" &&
  order.agentifyOrderIds.length === 1 &&
  order.agentifyOrderIds[0] === orderId &&
  order.orderKey !== "";

const soldItem = (
  orderId: string,
  email: string,
  facts: WooOrderFacts,
  product: { downloadId: string; fileName: string },
): SoldItem => ({
  orderId,
  productId: facts.productId,
  email,
  price: { amount: facts.amount, currency: facts.currency },
  download: { id: product.downloadId, name: product.fileName },
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
const unresolved = (why: string): WooRecoveryOutcome => ({ ok: false, state: "unresolved", why });
