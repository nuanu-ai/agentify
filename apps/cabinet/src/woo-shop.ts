/**
 * The two calls we make against a merchant's own shop.
 *
 * Reading the catalogue goes to the Store API, which WooCommerce serves to
 * anybody with no authentication at all — so no key is sent, because a secret
 * sent where it buys nothing is a secret in one more log. Creating the order
 * goes to `wc/v3` with the granted key pair as HTTP Basic, which is the scheme
 * WooCommerce accepts over https (`docs/research/33-woo-connect-probe.md`); the
 * shop address is refused at the door unless it is https, so there is one
 * scheme here and not two.
 *
 * Every failure comes back as a sentence the shop itself said, with a word for
 * whether asking again could change it. Both halves are for somebody else: the
 * sentence is what a merchant reads on a screen, and the word is what decides
 * whether an order is refused for good or handed back to be delivered again.
 */

import { createHash } from "node:crypto";
import type { Money } from "@nuanu-ai/agentify-contracts";
import { z } from "zod";
import {
  productIdFromMerchantItem,
  type StoreProduct,
  StoreProductsSchema,
} from "./woo-catalog.js";
import { type WooRequest, wooRequest } from "./woo-request.js";

/** How long we wait on a merchant's shop for one call. */
const SHOP_ANSWERS_WITHIN_MS = 15_000;

/**
 * How many products we ask for at a time.
 *
 * The Store API's own ceiling. Asking for fewer would be more round trips to
 * somebody else's server for the same catalogue.
 */
const PER_PAGE = 100;

/**
 * How many products the caller is willing to be handed, where it does not say.
 *
 * The ceiling is a parameter rather than a constant read here because the
 * caller is the one that knows what it can do with them — the import publishes
 * every one of them through the door while somebody holds a page open. Asked
 * for at all, it stops the walk as soon as it is passed: a shop with five
 * thousand products would otherwise be read whole, fifty round trips to
 * somebody else's server, and then refused for being too large.
 *
 * Ten thousand is the default and it is a guard rather than a policy: it stops
 * a shop answering a full page forever — a misconfigured proxy repeating one
 * response — from being a loop with a merchant watching it.
 */
const AT_MOST = 10_000;

/** The whole-import ceiling shown to a merchant before they start. */
export const PRODUCTS_AT_MOST = 200;

export type CatalogueRead =
  | { readonly ok: true; readonly products: readonly StoreProduct[] }
  | { readonly ok: false; readonly why: string };

/** Everything the shop needs to know us by, once a grant has been made. */
export interface ShopKeys {
  readonly shopUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
}

export interface EligibleWooProduct {
  readonly productId: string;
  readonly downloadId: string;
  readonly fileName: string;
  readonly price: Money;
  /** Digest of the delivery-critical product, settings and protected source. */
  readonly fingerprint: string;
}

export type ProductInspection =
  | { readonly ok: true; readonly product: EligibleWooProduct }
  | { readonly ok: false; readonly why: string };

export interface WooOrderRead {
  readonly id: string;
  readonly number: string;
  readonly orderKey: string;
  readonly status: string;
  readonly currency: string;
  readonly total: string;
  readonly totalTax: string;
  readonly paymentMethod: string;
  readonly transactionId: string;
  readonly billingEmail: string;
  readonly productId: string;
  readonly quantity: number;
  readonly subtotal: string;
  readonly lineTotal: string;
  readonly lineTax: string;
  readonly agentifyOrderIds: readonly unknown[];
}

export type WooOrderLookup =
  | { readonly ok: true; readonly order: WooOrderRead }
  | { readonly ok: false; readonly why: string };

const ProductSchema = z.looseObject({
  id: z.number().int().positive(),
  type: z.string(),
  status: z.string(),
  purchasable: z.boolean(),
  stock_status: z.string(),
  manage_stock: z.boolean(),
  virtual: z.boolean(),
  downloadable: z.boolean(),
  download_limit: z.number().int(),
  download_expiry: z.number().int(),
  sold_individually: z.boolean(),
  price: z.string(),
  downloads: z.array(z.looseObject({ id: z.string(), name: z.string(), file: z.string() })),
});

const SettingSchema = z.looseObject({ value: z.union([z.string(), z.boolean()]) });

/** Reads every fact that makes the connector able to deliver this product. */
export const inspectProductInTheShop = async (
  keys: ShopKeys,
  merchantItemId: string,
  request: WooRequest = wooRequest,
): Promise<ProductInspection> => {
  const productId = productIdFromMerchantItem(keys.shopUrl, merchantItemId);
  if (productId === null) {
    return { ok: false, why: "This card belongs to a different WooCommerce shop." };
  }
  const endpoints = [
    `/wp-json/wc/v3/products/${productId}`,
    "/wp-json/wc/v3/settings/general/woocommerce_currency",
    "/wp-json/wc/v3/settings/general/woocommerce_calc_taxes",
    "/wp-json/wc/v3/settings/products/woocommerce_file_download_method",
    "/wp-json/wc/v3/settings/products/woocommerce_downloads_require_login",
    "/wp-json/wc/v3/settings/products/woocommerce_downloads_grant_access_after_payment",
    "/wp-json/wc/v3/settings/products/woocommerce_downloads_redirect_fallback_allowed",
  ] as const;
  let responses: Response[];
  try {
    responses = await Promise.all(
      endpoints.map((path) =>
        request(`${keys.shopUrl}${path}`, {
          headers: { authorization: basicFor(keys), accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
        }),
      ),
    );
  } catch {
    return { ok: false, why: "The shop did not answer the protected product check." };
  }
  if (responses.some((response) => !response.ok)) {
    return { ok: false, why: "The shop refused the protected product or download-settings check." };
  }
  let documents: unknown[];
  try {
    documents = await Promise.all(responses.map((response) => response.json()));
  } catch {
    return { ok: false, why: "The shop's protected product check did not return readable JSON." };
  }
  const parsed = ProductSchema.safeParse(documents[0]);
  const settings = documents.slice(1).map((document) => SettingSchema.safeParse(document));
  if (!parsed.success) {
    return { ok: false, why: "The shop's protected product or settings document is incomplete." };
  }
  if (settings[1]?.success !== true) {
    return { ok: false, why: "The shop's tax calculation setting is unreadable." };
  }
  if (settings.some((setting) => !setting.success)) {
    return { ok: false, why: "The shop's protected product or settings document is incomplete." };
  }
  const product = parsed.data;
  const [currency, taxes, method, login, afterPayment, redirectFallback] = settings.map(
    (setting) => (setting.success ? setting.data.value : ""),
  );
  const unsupported: string[] = [];
  if (product.type !== "simple") unsupported.push("it is not a simple product");
  if (product.status !== "publish") unsupported.push("it is not published");
  if (!product.purchasable) unsupported.push("WooCommerce does not mark it purchasable");
  if (product.stock_status !== "instock") unsupported.push("it is out of stock");
  if (product.manage_stock) unsupported.push("managed stock is enabled");
  if (product.sold_individually) unsupported.push("sold individually is enabled");
  if (!product.virtual) unsupported.push("it is not virtual");
  if (!product.downloadable) unsupported.push("it is not downloadable");
  if (product.downloads.length !== 1) unsupported.push("it does not have exactly one file");
  if (product.download_limit !== -1) unsupported.push("its download count is limited");
  if (product.download_expiry !== -1) unsupported.push("its download access expires");
  if (currency !== "USD") unsupported.push("the shop currency is not USD");
  if (taxes !== "no") unsupported.push("WooCommerce tax calculation is not disabled");
  if (method !== "force") unsupported.push("the download method is not Force Downloads");
  if (login !== "no") unsupported.push("downloads require a WooCommerce login");
  if (afterPayment !== "yes") unsupported.push("download access is not granted after payment");
  if (redirectFallback !== "no") unsupported.push("insecure redirect fallback is enabled");
  if (unsupported.length > 0) {
    return {
      ok: false,
      why: `This product cannot be imported: ${unsupported.join("; ")}.`,
    };
  }
  const download = product.downloads[0];
  if (
    download === undefined ||
    download.id.trim() === "" ||
    download.name.trim() === "" ||
    !URL.canParse(download.file)
  ) {
    return { ok: false, why: "The product's one download does not name a readable address." };
  }
  const raw = new URL(download.file);
  if (raw.origin !== new URL(keys.shopUrl).origin) {
    return { ok: false, why: "The downloadable file is outside this shop's origin." };
  }
  try {
    const exposed = await request(raw, {
      redirect: "manual",
      signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
    });
    await exposed.body?.cancel();
    if (exposed.status !== 401 && exposed.status !== 403) {
      return { ok: false, why: "The downloadable file is public without an order permission." };
    }
  } catch {
    return { ok: false, why: "The shop's raw download protection could not be verified." };
  }
  if (!/^\d+(?:\.\d+)?$/.test(product.price)) {
    return { ok: false, why: "The protected product price is not a decimal amount." };
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        new URL(keys.shopUrl).origin,
        productId,
        download.id,
        download.name,
        raw.toString(),
        product.price,
        "USD",
        product.type,
        product.status,
        product.stock_status,
        product.manage_stock,
        product.sold_individually,
        product.virtual,
        product.downloadable,
        product.download_limit,
        product.download_expiry,
        taxes,
        method,
        login,
        afterPayment,
        redirectFallback,
      ]),
    )
    .digest("hex");
  return {
    ok: true,
    product: {
      productId,
      downloadId: download.id,
      fileName: download.name,
      price: { amount: product.price, currency: "USD" },
      fingerprint,
    },
  };
};

/** One sale, as the shop has to be told about it. */
export interface SoldItem {
  /** Our own order identifier, which goes onto the shop's order as a thread. */
  readonly orderId: string;
  /** The shop's own product identifier, which is the card's merchant_item_id. */
  readonly productId: string;
  /** Whose address goes on the order in the shop. */
  readonly email: string;
  /** What the buyer actually paid, which is what the shop's order records. */
  readonly price: Money;
  readonly download: { readonly id: string; readonly name: string };
}

export type OrderMade =
  | {
      readonly ok: true;
      readonly id: string;
      readonly number: string;
      readonly orderKey: string;
      readonly downloadId: string;
    }
  | {
      readonly ok: false;
      readonly why: string;
      /**
       * Whether making this same call again could land.
       *
       * True only where nothing was decided — a shop that did not answer, a
       * shop that fell over. A shop that answered and refused says the same
       * thing to the same call forever, and an order handed back for another
       * attempt on one of those spends a delivery the merchant never failed.
       */
      readonly again: boolean;
    };

/**
 * The whole of a shop's public catalogue.
 *
 * Paged until a page comes back short, which is how the Store API says there is
 * no more: it carries a header with the total, and reading the header would be
 * one more thing to be wrong about on a shop behind a proxy that strips it.
 */
export const catalogueOf = async (
  shopUrl: string,
  atMost: number = AT_MOST,
  request: WooRequest = wooRequest,
): Promise<CatalogueRead> => {
  const products: StoreProduct[] = [];
  const pages = Math.ceil(atMost / PER_PAGE) + 1;

  for (let page = 1; page <= pages; page += 1) {
    const at = `${shopUrl}/wp-json/wc/store/v1/products?per_page=${PER_PAGE}&page=${page}`;
    let answered: Response;
    try {
      answered = await request(at, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
      });
    } catch (thrown) {
      return { ok: false, why: `Your shop did not answer: ${String(thrown)}` };
    }

    const said = await answered.text();
    if (!answered.ok) {
      return {
        ok: false,
        why:
          `Your shop answered ${answered.status} when we asked for its catalog: ` +
          whatTheShopSaid(said, answered.status),
      };
    }

    let document: unknown;
    try {
      document = JSON.parse(said);
    } catch {
      return {
        ok: false,
        why:
          "Your shop answered the catalog address with something that is not JSON. Check that" +
          " nothing in front of it is serving a page of its own at /wp-json.",
      };
    }

    const read = StoreProductsSchema.safeParse(document);
    if (!read.success) {
      // Not folded into "no products". A catalogue that is empty and a
      // document we cannot read are different news, and a merchant told the
      // first would go looking for products that are sitting right there.
      return {
        ok: false,
        why:
          "Your shop answered the catalog address with a document we could not read as a list" +
          ` of products: ${read.error.issues[0]?.message ?? "the shape was not the expected one"}.`,
      };
    }

    products.push(...read.data);
    // The ceiling is read before the short page is, and the order of these two
    // is the whole of whether the ceiling means anything. The other way round,
    // a shop of two hundred and fifty products against a ceiling of two hundred
    // answers its third page short, and the short page returns them all — so
    // the number only ever bit on a catalogue that happened to be an exact
    // multiple of the page size, and everything in between came over whole with
    // nobody told.
    if (products.length > atMost) {
      // Stopped here rather than after the whole catalogue has been read: the
      // answer is the same either way, and the difference is how many round
      // trips somebody else's shop makes for a refusal.
      break;
    }
    if (read.data.length < PER_PAGE) {
      return { ok: true, products };
    }
  }

  return {
    ok: false,
    why:
      `Your shop offers more than ${atMost} products, which is more than this brings over in one` +
      " go. Nothing was imported.",
  };
};

/**
 * Creates one paid order in the merchant's shop.
 *
 * `set_paid` is the whole point: without it the order sits in the shop's
 * pending list and the merchant never ships it, although the buyer has paid.
 * The probe measured what the shop does with it — status `processing`, a
 * `date_paid` the shop stamps itself, and the order on the screen in wp-admin.
 *
 * It also sends two emails, one to the merchant and one to the address on the
 * order, and nothing in the request can suppress them. That is why the address
 * below is the merchant's own: see the decision record.
 *
 * The price sent is what the buyer actually paid rather than what the shop
 * charges today. The two can disagree — a merchant who changed a price after
 * the card was published — and of the two numbers, the one the shop's order
 * should record is the one the money moved for.
 */
export const createTheOrderInTheShop = async (
  keys: ShopKeys,
  sold: SoldItem,
  request: WooRequest = wooRequest,
): Promise<OrderMade> => {
  const productId = Number(sold.productId);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    return {
      ok: false,
      why:
        `This card is keyed by ${JSON.stringify(sold.productId)}, which is not a product` +
        " identifier in a WooCommerce shop, so there is nothing in the shop to order.",
      again: false,
    };
  }

  const body = {
    payment_method: "agentify",
    payment_method_title: "Agentify",
    // The shop stores this string without checking it, and shows it on the
    // order screen — so it is our own order identifier, which is the one thread
    // between an order here and an order there.
    transaction_id: sold.orderId,
    set_paid: true,
    currency: sold.price.currency,
    billing: { email: sold.email },
    meta_data: [{ key: "agentify_order_id", value: sold.orderId }],
    line_items: [
      {
        product_id: productId,
        quantity: 1,
        subtotal: sold.price.amount,
        total: sold.price.amount,
      },
    ],
  };

  let answered: Response;
  try {
    answered = await request(`${keys.shopUrl}/wp-json/wc/v3/orders`, {
      method: "POST",
      headers: {
        authorization: basicFor(keys),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
    });
  } catch {
    // Nothing was decided. It is also the one case where the order may have
    // reached the shop and the answer may have been lost, which is why the
    // caller keeps a record of having tried before it tries.
    return { ok: false, why: "The shop did not answer the order call.", again: true };
  }

  const said = await answered.text();

  if (!answered.ok) {
    return {
      ok: false,
      why: `The shop refused the order call (HTTP ${answered.status}).`,
      again: worthAskingAgain(answered.status),
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(said);
  } catch {
    // A successful HTTP status means Woo may already have committed the order.
    // Without its body we cannot bind that order, and treating this as a final
    // refusal would release the local claim and let redelivery POST a duplicate.
    return {
      ok: false,
      why: "The shop answered the order call with something that is not JSON.",
      again: true,
    };
  }

  const made = document as {
    id?: unknown;
    number?: unknown;
    order_key?: unknown;
    status?: unknown;
    currency?: unknown;
    total?: unknown;
    total_tax?: unknown;
    payment_method?: unknown;
    transaction_id?: unknown;
    billing?: unknown;
    meta_data?: unknown;
    line_items?: unknown;
  };
  const id = typeof made.id === "number" ? String(made.id) : null;
  if (id === null) {
    // The shop said yes and named no order. Whatever is at that address, it is
    // not WooCommerce answering, and claiming an order number out of it would
    // hand the buyer a string that means nothing in the merchant's shop.
    return {
      ok: false,
      why:
        "The shop accepted the order and its answer names no order, so there is nothing to tell" +
        " the buyer. Nothing here can say whether an order was created.",
      again: true,
    };
  }
  const number = typeof made.number === "string" && made.number !== "" ? made.number : id;
  if (typeof made.order_key !== "string" || made.order_key === "") {
    return {
      ok: false,
      why: "The shop accepted the order but returned no order key for its private download.",
      again: true,
    };
  }
  const lineItems = Array.isArray(made.line_items) ? made.line_items : [];
  const billing = made.billing as { email?: unknown } | undefined;
  const metadata = Array.isArray(made.meta_data) ? made.meta_data : [];
  const orderIds = metadata
    .filter(
      (one): one is { key: string; value: unknown } =>
        typeof one === "object" && one !== null && "key" in one && "value" in one,
    )
    .filter((one) => one.key === "agentify_order_id")
    .map((one) => one.value);
  const line = lineItems[0] as
    | {
        product_id?: unknown;
        quantity?: unknown;
        subtotal?: unknown;
        total?: unknown;
        total_tax?: unknown;
      }
    | undefined;
  if (
    !["processing", "completed"].includes(String(made.status)) ||
    made.currency !== sold.price.currency ||
    made.total !== sold.price.amount ||
    made.total_tax !== "0.00" ||
    lineItems.length !== 1 ||
    line?.product_id !== productId ||
    line.quantity !== 1 ||
    line.subtotal !== sold.price.amount ||
    line.total !== sold.price.amount ||
    line.total_tax !== "0.00" ||
    made.payment_method !== "agentify" ||
    made.transaction_id !== sold.orderId ||
    billing?.email !== sold.email ||
    orderIds.length !== 1 ||
    orderIds[0] !== sold.orderId
  ) {
    return {
      ok: false,
      why: "The shop created an order whose paid amount, product or Agentify correlation does not match the sale.",
      again: true,
    };
  }
  return { ok: true, id, number, orderKey: made.order_key, downloadId: sold.download.id };
};

/** Reads one operator-named order; it never scans or infers that no order exists. */
export const readTheOrderInTheShop = async (
  keys: ShopKeys,
  wooOrderId: string,
  request: WooRequest = wooRequest,
): Promise<WooOrderLookup> => {
  if (!/^\d+$/.test(wooOrderId) || Number(wooOrderId) <= 0) {
    return { ok: false, why: "The WooCommerce order id must be a positive whole number." };
  }
  let answered: Response;
  try {
    answered = await request(`${keys.shopUrl}/wp-json/wc/v3/orders/${wooOrderId}`, {
      headers: { authorization: basicFor(keys), accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
    });
  } catch {
    return { ok: false, why: "The shop did not answer the exact-order check." };
  }
  const said = await answered.text();
  if (!answered.ok) {
    return {
      ok: false,
      why: `The shop refused the exact-order check (HTTP ${answered.status}).`,
    };
  }
  let document: unknown;
  try {
    document = JSON.parse(said);
  } catch {
    return { ok: false, why: "The exact WooCommerce order was not readable JSON." };
  }
  const parsed = ExactOrderSchema.safeParse(document);
  if (!parsed.success || parsed.data.line_items.length !== 1) {
    return { ok: false, why: "The exact WooCommerce order is incomplete or ambiguous." };
  }
  const order = parsed.data;
  const line = order.line_items[0];
  if (line === undefined) {
    return { ok: false, why: "The exact WooCommerce order has no product line." };
  }
  return {
    ok: true,
    order: {
      id: String(order.id),
      number: String(order.number),
      orderKey: order.order_key,
      status: order.status,
      currency: order.currency,
      total: order.total,
      totalTax: order.total_tax,
      paymentMethod: order.payment_method,
      transactionId: order.transaction_id,
      billingEmail: order.billing.email,
      productId: String(line.product_id),
      quantity: line.quantity,
      subtotal: line.subtotal,
      lineTotal: line.total,
      lineTax: line.total_tax,
      agentifyOrderIds: order.meta_data
        .filter((one) => one.key === "agentify_order_id")
        .map((one) => one.value),
    },
  };
};

const ExactOrderSchema = z.looseObject({
  id: z.number().int().positive(),
  number: z.union([z.string().min(1), z.number().int().positive()]),
  order_key: z.string().min(1),
  status: z.string(),
  currency: z.string(),
  total: z.string(),
  total_tax: z.string(),
  payment_method: z.string(),
  transaction_id: z.string(),
  billing: z.looseObject({ email: z.string() }),
  line_items: z.array(
    z.looseObject({
      product_id: z.number().int().positive(),
      quantity: z.number().int().positive(),
      subtotal: z.string(),
      total: z.string(),
      total_tax: z.string(),
    }),
  ),
  meta_data: z.array(z.looseObject({ key: z.string(), value: z.unknown() })),
});

/**
 * Whether a shop that answered with this status is worth asking again.
 *
 * A 5xx is the shop having a bad moment. So are the two below, and they are
 * named rather than left to fall through with the rest: a shop behind a rate
 * limiter or a proxy answers `429 Too Many Requests` and `408 Request Timeout`,
 * both of which mean "ask again in a moment" and neither of which is a 5xx.
 * Read as final, they close a sale for good and hand the buyer a refusal —
 * which is what a shop having a busy afternoon would cost its own merchant.
 *
 * Everything else is the shop having read the request and said no, and it will
 * say no again.
 */
const worthAskingAgain = (status: number): boolean =>
  status >= 500 || status === 408 || status === 429;

/** The key pair as WooCommerce takes it over https. */
const basicFor = (keys: ShopKeys): string =>
  `Basic ${Buffer.from(`${keys.consumerKey}:${keys.consumerSecret}`).toString("base64")}`;

/**
 * What the shop said, out of its own error document, or the status where there
 * is nothing to read.
 *
 * WordPress refuses in a shape of its own — a code and a message — and the
 * message is written for a person. What sits between us and the shop can be a
 * proxy or a firewall with a page of its own, which is why this falls back to
 * the status rather than parsing its way into an exception.
 */
const whatTheShopSaid = (said: string, status: number): string => {
  try {
    const body = JSON.parse(said) as { message?: unknown };
    if (typeof body.message === "string" && body.message !== "") {
      return body.message;
    }
  } catch {
    // Not a document. The status is the whole of what is known.
  }
  return `the answer carried no message we could read (HTTP ${status}).`;
};
