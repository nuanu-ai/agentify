/**
 * The calls made against a merchant's own shop. The Store API needs no key, so
 * none is sent: a secret sent where it buys nothing is a secret in one more
 * log. Order calls go to `wc/v3` with the granted keys as HTTP Basic, which
 * WooCommerce accepts over https; the shop address must be https, so there is
 * one scheme.
 *
 * Every failure comes back as a sentence the shop said plus `again`, which
 * decides whether an order is refused for good or handed back to be delivered
 * again.
 */

import { createHash } from "node:crypto";
import {
  type Money,
  type Shipment,
  ShipmentSchema,
  type ShipTo,
  type ShipToLocality,
} from "@nuanu-ai/agentify-contracts";
import { z } from "zod";
import { percentOf, type SplitTerms, sharesOf } from "./shares.js";
import {
  decimalOfMinorUnits,
  productIdFromMerchantItem,
  type StoreProduct,
  StoreProductsSchema,
  TYPED_PRICE,
  USD_SCALE,
  usdAmountOf,
} from "./woo-catalog.js";
import { type WooRequest, wooRequest } from "./woo-request.js";

const SHOP_ANSWERS_WITHIN_MS = 15_000;

/** The Store API's own ceiling. */
const PER_PAGE = 100;

/**
 * A guard rather than a policy: it stops a shop that answers a full page
 * forever (a misconfigured proxy repeating one response) from being an endless
 * loop. The caller passes its own, lower ceiling.
 */
const AT_MOST = 10_000;

/**
 * Shown to a merchant before they start, and named on the page that refuses a
 * larger catalogue rather than silently importing the first two hundred: every
 * product is a separate publish call while a merchant holds the page open.
 */
export const PRODUCTS_AT_MOST = 200;

export type CatalogueRead =
  | { readonly ok: true; readonly products: readonly StoreProduct[] }
  | { readonly ok: false; readonly why: string };

export interface ShopKeys {
  readonly shopUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
}

/** One protected file handed to the agent. */
interface EligibleDownload {
  readonly kind: "download";
  readonly productId: string;
  readonly downloadId: string;
  readonly fileName: string;
  readonly price: Money;
  /** Digest of the delivery-critical product, settings and protected source. */
  readonly fingerprint: string;
}

/** Sold as a parcel for the shop to ship. */
interface EligibleParcel {
  readonly kind: "parcel";
  readonly productId: string;
  /** The goods alone; shipping is the shop's rate for the buyer's place. */
  readonly price: Money;
  /** Digest of the product and the shop settings a parcel is sold under. */
  readonly fingerprint: string;
}

export type EligibleWooProduct = EligibleDownload | EligibleParcel;

export type ProductInspection =
  | { readonly ok: true; readonly product: EligibleWooProduct }
  /**
   * `again` says the shop failed to answer rather than answered no: it has said
   * nothing about the product, and what is told about the sale must not give a
   * reason that is not true.
   */
  | { readonly ok: false; readonly why: string; readonly again: boolean };

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

/**
 * Download and shipping settings are asked for in one batch, one round trip
 * whichever class the product is, and only the answers bearing on its class
 * decide; a shop that hides its download settings can still sell a parcel.
 */
export const inspectProductInTheShop = async (
  keys: ShopKeys,
  merchantItemId: string,
  request: WooRequest = wooRequest,
): Promise<ProductInspection> => {
  const productId = productIdFromMerchantItem(keys.shopUrl, merchantItemId);
  if (productId === null) {
    return { ok: false, why: "This card belongs to a different WooCommerce shop.", again: false };
  }
  const endpoints = [
    `/wp-json/wc/v3/products/${productId}`,
    "/wp-json/wc/v3/settings/general/woocommerce_currency",
    "/wp-json/wc/v3/settings/general/woocommerce_calc_taxes",
    "/wp-json/wc/v3/settings/products/woocommerce_file_download_method",
    "/wp-json/wc/v3/settings/products/woocommerce_downloads_require_login",
    "/wp-json/wc/v3/settings/products/woocommerce_downloads_grant_access_after_payment",
    "/wp-json/wc/v3/settings/products/woocommerce_downloads_redirect_fallback_allowed",
    "/wp-json/wc/v3/settings/general/woocommerce_price_num_decimals",
    "/wp-json/wc/v3/settings/general/woocommerce_ship_to_countries",
    "/wp-json/wc/v3/settings/shipping/woocommerce_ship_to_destination",
  ] as const;
  /** The product first. */
  const BEARING = {
    download: [0, 1, 2, 3, 4, 5, 6, 7],
    parcel: [0, 1, 2, 7, 8, 9],
  } as const;
  let responses: Response[];
  let bodies: string[];
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
    return { ok: false, why: "The shop did not answer the protected product check.", again: true };
  }
  try {
    bodies = await Promise.all(responses.map((response) => response.text()));
  } catch {
    return {
      ok: false,
      why: "The shop's protected product check did not return readable JSON.",
      again: false,
    };
  }
  /** Undefined where it is not JSON. */
  const documentOf = (index: number): unknown => {
    try {
      return JSON.parse(bodies[index] ?? "");
    } catch {
      return undefined;
    }
  };
  const unanswered = (indices: readonly number[]): ProductInspection | null => {
    if (indices.some((index) => worthAskingAgain(responses[index]?.status ?? 0))) {
      return {
        ok: false,
        why: "The shop was too busy to answer the protected product check.",
        again: true,
      };
    }
    if (indices.some((index) => responses[index]?.ok !== true)) {
      return {
        ok: false,
        why: "The shop refused the protected product or its settings check.",
        again: false,
      };
    }
    if (indices.some((index) => documentOf(index) === undefined)) {
      return {
        ok: false,
        why: "The shop's protected product check did not return readable JSON.",
        again: false,
      };
    }
    return null;
  };
  const productUnanswered = unanswered([0]);
  if (productUnanswered !== null) return productUnanswered;
  const parsed = ProductSchema.safeParse(documentOf(0));
  if (!parsed.success) {
    return {
      ok: false,
      why: "The shop's protected product or settings document is incomplete.",
      again: false,
    };
  }
  const product = parsed.data;
  // What is returned carries the identity asked for, so a document naming
  // another product, as a cache or rewrite in front of the shop can serve,
  // would lend this card that product's eligibility, price and file.
  if (String(product.id) !== productId) {
    return {
      ok: false,
      why:
        `The shop answered the check of product ${productId} with product ${product.id}'s` +
        " document, so nothing in it can be taken for this card.",
      again: false,
    };
  }
  // Neither virtual nor downloadable is a parcel; everything else is judged as
  // a download, so a virtual product with no file is told what a download
  // lacks.
  const kind = !product.virtual && !product.downloadable ? "parcel" : "download";
  const settingsUnanswered = unanswered(BEARING[kind]);
  if (settingsUnanswered !== null) return settingsUnanswered;
  const settings = endpoints.map((_, index) => SettingSchema.safeParse(documentOf(index)));
  if (settings[2]?.success !== true) {
    return { ok: false, why: "The shop's tax calculation setting is unreadable.", again: false };
  }
  if (BEARING[kind].slice(1).some((index) => settings[index]?.success !== true)) {
    return {
      ok: false,
      why: "The shop's protected product or settings document is incomplete.",
      again: false,
    };
  }
  const [
    ,
    currency,
    taxes,
    method,
    login,
    afterPayment,
    redirectFallback,
    decimals,
    shipTo,
    destination,
  ] = settings.map((setting) => (setting.success ? setting.data.value : ""));
  const unsupported: string[] = [];
  if (product.type !== "simple") unsupported.push("it is not a simple product");
  if (product.status !== "publish") unsupported.push("it is not published");
  if (!product.purchasable) unsupported.push("WooCommerce does not mark it purchasable");
  if (product.stock_status !== "instock") unsupported.push("it is out of stock");
  if (product.manage_stock) unsupported.push("managed stock is enabled");
  if (product.sold_individually) unsupported.push("sold individually is enabled");
  if (kind === "download") {
    if (!product.virtual) unsupported.push("it is not virtual");
    if (!product.downloadable) unsupported.push("it is not downloadable");
    if (product.downloads.length !== 1) unsupported.push("it does not have exactly one file");
    if (product.download_limit !== -1) unsupported.push("its download count is limited");
    if (product.download_expiry !== -1) unsupported.push("its download access expires");
  }
  if (currency !== "USD") unsupported.push("the shop currency is not USD");
  if (taxes !== "no") unsupported.push("WooCommerce tax calculation is not disabled");
  if (kind === "download") {
    if (method !== "force") unsupported.push("the download method is not Force Downloads");
    if (login !== "no") unsupported.push("downloads require a WooCommerce login");
    if (afterPayment !== "yes") unsupported.push("download access is not granted after payment");
    if (redirectFallback !== "no") unsupported.push("insecure redirect fallback is enabled");
  }
  if (kind === "parcel") {
    if (shipTo === "disabled") {
      unsupported.push(
        "the shop has shipping switched off (WooCommerce → Settings → General → Shipping" +
          " location(s))",
      );
    }
    // Such a shop keeps the buyer's address as billing and shows no shipping
    // address on its order screen, so the merchant would not see where the
    // parcel goes.
    if (destination === "billing_only") {
      unsupported.push(
        "the shop forces shipping to the customer billing address (WooCommerce → Settings →" +
          " Shipping → Shipping destination)",
      );
    }
  }
  // Order totals are written at this setting and matched character for
  // character, so any other value is refused before a paid order exists that
  // could not be matched. Left out of the download fingerprint, so fingerprints
  // already recorded for accepted quotes stay valid.
  if (decimals !== String(USD_SCALE)) {
    unsupported.push(
      `prices are not written at ${USD_SCALE} decimals (set WooCommerce → Settings → General →` +
        ` Number of decimals to ${USD_SCALE})`,
    );
  }
  if (unsupported.length > 0) {
    return {
      ok: false,
      why: `This product cannot be imported: ${unsupported.join("; ")}.`,
      again: false,
    };
  }
  if (!TYPED_PRICE.test(product.price)) {
    return { ok: false, why: "The protected product price is not a decimal amount.", again: false };
  }
  // From here on the price is the one form the card, the quote, the order and
  // WooCommerce's totals all use; the fingerprint hashes it too, so "25" and
  // "25.00" hash alike and earlier digests stay valid.
  const amount = usdAmountOf(product.price);
  if (amount === null) {
    return {
      ok: false,
      why:
        `The shop's price for this product is ${product.price}, which has more than the two` +
        " decimal places a US dollar price has. It is not rounded to an amount the shop never" +
        " set; give the product a price in whole cents in WooCommerce.",
      again: false,
    };
  }
  if (kind === "parcel") {
    // The class is hashed first, so a parcel's digest can never equal a
    // download's: a product that changed class after its quote has changed.
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "parcel",
          new URL(keys.shopUrl).origin,
          productId,
          amount,
          "USD",
          product.type,
          product.status,
          product.stock_status,
          product.manage_stock,
          product.sold_individually,
          product.virtual,
          product.downloadable,
          taxes,
          shipTo,
          destination,
        ]),
      )
      .digest("hex");
    return {
      ok: true,
      product: { kind, productId, price: { amount, currency: "USD" }, fingerprint },
    };
  }
  const download = product.downloads[0];
  if (
    download === undefined ||
    download.id.trim() === "" ||
    download.name.trim() === "" ||
    !URL.canParse(download.file)
  ) {
    return {
      ok: false,
      why: "The product's one download does not name a readable address.",
      again: false,
    };
  }
  const raw = new URL(download.file);
  if (raw.origin !== new URL(keys.shopUrl).origin) {
    return { ok: false, why: "The downloadable file is outside this shop's origin.", again: false };
  }
  try {
    const exposed = await request(raw, {
      redirect: "manual",
      signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
    });
    await exposed.body?.cancel();
    if (worthAskingAgain(exposed.status)) {
      return {
        ok: false,
        why: "The shop's raw download protection could not be verified.",
        again: true,
      };
    }
    if (exposed.status !== 401 && exposed.status !== 403) {
      return {
        ok: false,
        why: "The downloadable file is public without an order permission.",
        again: false,
      };
    }
  } catch {
    // Not silence: this also fails on a public file too large to read, which is
    // an answer, and the shop has answered every other part of the check.
    return {
      ok: false,
      why: "The shop's raw download protection could not be verified.",
      again: false,
    };
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        new URL(keys.shopUrl).origin,
        productId,
        download.id,
        download.name,
        raw.toString(),
        amount,
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
      kind,
      productId,
      downloadId: download.id,
      fileName: download.name,
      price: { amount, currency: "USD" },
      fingerprint,
    },
  };
};

/**
 * The payout split a sale's payment was checked against, as recorded: where
 * the money went, and the shares it divides it in. Null on a sale paid to the
 * merchant's wallet itself, before payments went to splits.
 */
export type PaidIntoSplit = SplitTerms & { readonly address: string };

export interface SoldItem {
  /** Goes onto the shop's order as the thread between the two. */
  readonly orderId: string;
  /** The card's `merchant_item_id`. */
  readonly productId: string;
  readonly email: string;
  /** What the buyer actually paid, which is what the shop's order records. */
  readonly price: Money;
  readonly download: { readonly id: string; readonly name: string };
  readonly paidInto: PaidIntoSplit | null;
}

/**
 * The shop order's metadata: our order identifier, and for a payment into a
 * split two lines the merchant reads beside the order, the commission on what
 * was paid and the split it went to. No key begins with an underscore, which
 * WooCommerce hides. The answer check reads only the identifier, so the lines
 * neither break nor weaken it.
 */
const metadataOf = (
  orderId: string,
  paid: Money,
  into: PaidIntoSplit | null,
): readonly { readonly key: string; readonly value: string }[] => [
  { key: "agentify_order_id", value: orderId },
  ...(into === null
    ? []
    : [
        {
          key: "agentify_commission",
          value: `${sharesOf(paid, into).commission} (${percentOf(into.commissionAllocation, into.totalAllocation)})`,
        },
        { key: "agentify_payout_contract", value: into.address },
      ]),
];

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
       * True only where nothing was decided: no answer, or a shop that fell
       * over. A shop that refused will refuse the same call forever, and
       * handing the order back for another attempt would spend a delivery the
       * merchant never failed.
       */
      readonly again: boolean;
    };

/**
 * Paged until a page comes back short, rather than trusting the total header,
 * which a proxy may strip.
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
      // Not folded into "no products": a merchant told the catalogue is empty
      // would go looking for products that are there.
      return {
        ok: false,
        why:
          "Your shop answered the catalog address with a document we could not read as a list" +
          ` of products: ${read.error.issues[0]?.message ?? "the shape was not the expected one"}.`,
      };
    }

    products.push(...read.data);
    // The ceiling is checked before the short page: the other way round, a
    // catalogue of 250 against a ceiling of 200 would come back whole on its
    // short third page.
    if (products.length > atMost) {
      // Stopped here, so somebody else's shop makes fewer round trips for a
      // refusal.
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

export interface ShippingRate {
  /** `flat_rate` and the like, named by an order's shipping line. */
  readonly methodId: string;
  /**
   * The method's instance in the matched zone, also named by the shipping line.
   */
  readonly instanceId: string;
  /** As the shop's own checkout calls it. */
  readonly title: string;
  /** In US dollars at two decimals, as an order's shipping line carries it. */
  readonly cost: string;
}

export type RatesRead =
  | { readonly ok: true; readonly rates: readonly ShippingRate[] }
  | { readonly ok: false; readonly why: string; readonly again: boolean };

/** Usually the cheapest on offer, and a parcel nobody collects never leaves. */
const NOT_SHIPPING = new Set(["local_pickup", "pickup_location"]);

const CartRateSchema = z.looseObject({
  method_id: z.string(),
  instance_id: z.union([z.number().int(), z.string()]),
  name: z.string(),
  price: z.string(),
  taxes: z.string(),
  currency_code: z.string(),
  currency_minor_unit: z.number().int(),
});

const CartSchema = z.looseObject({
  needs_shipping: z.boolean(),
  shipping_rates: z.array(z.looseObject({ shipping_rates: z.array(CartRateSchema) })),
});

/**
 * WooCommerce has no endpoint that calculates a rate, so this uses the Store
 * API cart as a browserless client can: a fresh cart whose token stands in for
 * a nonce, the product added, the place set, the rates read off the answer.
 * Every field of the place is sent, empty where the address has none, because a
 * field left out keeps the shop's own base location; nothing about who is sent,
 * and no key. The cart stays in the shop as a guest session, which WooCommerce
 * expires after two days.
 *
 * Rates come back in the shop's order with pickup left out. An empty list means
 * the shop does not ship there; a refusal is said apart, in our own words,
 * because the shop's message names the place.
 */
export const shippingRatesInTheShop = async (
  shopUrl: string,
  productId: string,
  place: ShipToLocality,
  request: WooRequest = wooRequest,
): Promise<RatesRead> => {
  const product = Number(productId);
  if (!Number.isSafeInteger(product) || product <= 0) {
    return { ok: false, why: "The card names no product in a WooCommerce shop.", again: false };
  }
  const cart = `${shopUrl}/wp-json/wc/store/v1/cart`;
  const ask = async (
    url: string,
    init: RequestInit,
  ): Promise<
    | { readonly ok: true; readonly response: Response; readonly body: string }
    | { readonly ok: false; readonly why: string; readonly again: boolean }
  > => {
    let response: Response;
    let body: string;
    try {
      response = await request(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
      });
      body = await response.text();
    } catch {
      return { ok: false, why: "The shop's cart did not answer.", again: true };
    }
    if (worthAskingAgain(response.status)) {
      return { ok: false, why: "The shop's cart was too busy to answer.", again: true };
    }
    if (!response.ok) {
      return {
        ok: false,
        why: `The shop's cart refused the question (HTTP ${response.status}).`,
        again: false,
      };
    }
    return { ok: true, response, body };
  };

  const opened = await ask(cart, { headers: { accept: "application/json" } });
  if (!opened.ok) return opened;
  const token = opened.response.headers.get("cart-token");
  if (token === null || token === "") {
    return {
      ok: false,
      why: "The shop's cart gave no cart token, and without one it takes no question from us.",
      again: false,
    };
  }
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "cart-token": token,
  };
  const added = await ask(`${cart}/add-item`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: product, quantity: 1 }),
  });
  if (!added.ok) return added;
  const placed = await ask(`${cart}/update-customer`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      shipping_address: {
        country: place.country,
        state: place.state ?? "",
        city: place.city,
        postcode: place.postal_code ?? "",
      },
    }),
  });
  if (!placed.ok) return placed;

  let document: unknown;
  try {
    document = JSON.parse(placed.body);
  } catch {
    return { ok: false, why: "The shop's cart did not answer with JSON.", again: false };
  }
  const read = CartSchema.safeParse(document);
  if (!read.success) {
    return { ok: false, why: "The shop's cart answered without its shipping rates.", again: false };
  }
  if (!read.data.needs_shipping) {
    return { ok: false, why: "The shop's cart says this product needs no shipping.", again: false };
  }
  const [only, ...more] = read.data.shipping_rates;
  if (only === undefined || more.length > 0) {
    // One product is one parcel; a shop that splits it or answers with no
    // package is not pricing what this sells.
    return {
      ok: false,
      why: "The shop's cart did not price this product as one parcel.",
      again: false,
    };
  }
  const rates: ShippingRate[] = [];
  for (const rate of only.shipping_rates) {
    if (NOT_SHIPPING.has(rate.method_id)) continue;
    const cost =
      rate.currency_code === "USD" && rate.currency_minor_unit === USD_SCALE && rate.taxes === "0"
        ? decimalOfMinorUnits(rate.price, USD_SCALE)
        : null;
    if (cost === null) {
      // Not dropped: a rate left out in silence could make another look
      // cheapest, and the shop would charge what we did not say.
      return {
        ok: false,
        why: "The shop's cart offered a shipping rate that is not an untaxed US dollar amount.",
        again: false,
      };
    }
    rates.push({
      methodId: rate.method_id,
      instanceId: String(rate.instance_id),
      title: rate.name,
      cost,
    });
  }
  return { ok: true, rates };
};

/**
 * `set_paid` moves the order to `processing` with a `date_paid` the shop
 * stamps, so the merchant ships it; without it the order sits pending although
 * the buyer paid. It also makes the shop send two emails, one to the address on
 * the order, which nothing can suppress, so the order carries the merchant's
 * own address and the buyer receives no shop mail. The price sent is what the
 * buyer paid, not what the shop charges today.
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
    // The shop stores and shows this string unchecked, so it carries our order
    // identifier, the one thread between the two orders.
    transaction_id: sold.orderId,
    set_paid: true,
    currency: sold.price.currency,
    billing: { email: sold.email },
    meta_data: metadataOf(sold.orderId, sold.price, sold.paidInto),
    line_items: [
      {
        product_id: productId,
        quantity: 1,
        subtotal: sold.price.amount,
        total: sold.price.amount,
      },
    ],
  };

  const posted = await postTheOrder(keys, body, null, request);
  if (!posted.ok) return posted;
  const document = posted.document;

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
    // A yes naming no order is not WooCommerce answering, and an order number
    // taken from it would mean nothing in the merchant's shop.
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

/**
 * Only a shop that answered and refused says asking again cannot land. A yes
 * with an unreadable body may already hold the order, which is the case the
 * caller's claim exists for.
 */
const postTheOrder = async (
  keys: ShopKeys,
  body: Readonly<Record<string, unknown>>,
  fields: readonly string[] | null,
  request: WooRequest,
): Promise<
  | { readonly ok: true; readonly document: unknown }
  | { readonly ok: false; readonly why: string; readonly again: boolean }
> => {
  const address = new URL(`${keys.shopUrl}/wp-json/wc/v3/orders`);
  if (fields !== null) address.searchParams.set("_fields", fields.join(","));
  let answered: Response;
  let said: string;
  try {
    answered = await request(address.toString(), {
      method: "POST",
      headers: {
        authorization: basicFor(keys),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
    });
    said = await answered.text();
  } catch {
    // Nothing was decided, but the order may have reached the shop with the
    // answer lost, which is why the caller records the attempt before making
    // it.
    return { ok: false, why: "The shop did not answer the order call.", again: true };
  }

  if (!answered.ok) {
    return {
      ok: false,
      why: `The shop refused the order call (HTTP ${answered.status}).`,
      again: worthAskingAgain(answered.status),
    };
  }

  try {
    return { ok: true, document: JSON.parse(said) };
  } catch {
    // A successful HTTP status means WooCommerce may already have committed the
    // order. Without its body the order cannot be bound, and treating this as a
    // final refusal would release the local claim and let redelivery POST a
    // duplicate.
    return {
      ok: false,
      why: "The shop answered the order call with something that is not JSON.",
      again: true,
    };
  }
};

export interface ParcelSold {
  /** Goes onto the shop's order as the thread between the two. */
  readonly orderId: string;
  readonly productId: string;
  /**
   * The merchant's own address, as on a download's order, so no shop mail
   * reaches the buyer.
   */
  readonly email: string;
  /** The goods and the shipping together. */
  readonly paid: Money;
  /** The goods alone: the order's product line. */
  readonly goods: string;
  /** The order's shipping line. */
  readonly rate: ShippingRate;
  /** Read into the order and not kept anywhere of ours. */
  readonly address: ShipTo;
  readonly paidInto: PaidIntoSplit | null;
}

export type ParcelMade =
  | { readonly ok: true; readonly id: string; readonly number: string }
  | {
      readonly ok: false;
      readonly why: string;
      readonly again: boolean;
      /** Where the shop named one for an order that does not match the sale. */
      readonly id?: string;
    };

/**
 * The whole name goes into the first name, because splitting it would be a
 * guess. A missing part is written empty, as WooCommerce keeps it.
 */
const shippingOf = (address: ShipTo): Readonly<Record<string, string>> => ({
  first_name: address.name,
  address_1: address.line_one,
  address_2: address.line_two ?? "",
  city: address.city,
  state: address.state ?? "",
  postcode: address.postal_code ?? "",
  country: address.country,
  phone: address.phone_number,
});

/** Nothing else the shop would echo is read. */
const PARCEL_ORDER_FIELDS = [
  "id",
  "number",
  "status",
  "currency",
  "total",
  "total_tax",
  "payment_method",
  "transaction_id",
  "billing",
  "shipping",
  "meta_data",
  "line_items",
  "shipping_lines",
] as const;

/**
 * The order's totals add up to what was paid; paying moves it to `processing`.
 * The billing address is the merchant's own, so no shop mail reaches the buyer.
 *
 * The answer is read back with the address and held to what was sent, because
 * taking the order on erases Agentify's copy of the address: an order is not
 * placed until the shop is seen holding where it goes. The address is compared
 * and goes no further: no answer here carries it, nor any sentence the shop
 * wrote, which may name it.
 */
export const createTheParcelInTheShop = async (
  keys: ShopKeys,
  sold: ParcelSold,
  request: WooRequest = wooRequest,
): Promise<ParcelMade> => {
  const productId = Number(sold.productId);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    return {
      ok: false,
      why: "This card names no product in a WooCommerce shop, so there is nothing to order.",
      again: false,
    };
  }
  const shipping = shippingOf(sold.address);
  const body = {
    payment_method: "agentify",
    payment_method_title: "Agentify",
    transaction_id: sold.orderId,
    set_paid: true,
    currency: sold.paid.currency,
    billing: { email: sold.email },
    shipping,
    // On what was paid, the goods and the shipping together: the split took
    // the whole of it.
    meta_data: metadataOf(sold.orderId, sold.paid, sold.paidInto),
    line_items: [{ product_id: productId, quantity: 1, subtotal: sold.goods, total: sold.goods }],
    shipping_lines: [
      {
        method_id: sold.rate.methodId,
        instance_id: sold.rate.instanceId,
        method_title: sold.rate.title,
        total: sold.rate.cost,
      },
    ],
  };
  const posted = await postTheOrder(keys, body, PARCEL_ORDER_FIELDS, request);
  if (!posted.ok) return posted;

  const read = ParcelOrderSchema.safeParse(posted.document);
  if (!read.success) {
    return {
      ok: false,
      why: "The shop accepted the order and its answer is not a whole WooCommerce order.",
      again: true,
    };
  }
  const made = read.data;
  const [line, ...moreLines] = made.line_items;
  const [carriage, ...moreCarriage] = made.shipping_lines;
  const orderIds = made.meta_data
    .filter((one) => one.key === "agentify_order_id")
    .map((one) => one.value);
  const heldWhereItGoes =
    made.shipping !== undefined &&
    Object.entries(shipping).every(([field, value]) => made.shipping?.[field] === value);
  if (
    !["processing", "completed"].includes(made.status) ||
    made.currency !== sold.paid.currency ||
    made.total !== sold.paid.amount ||
    made.total_tax !== "0.00" ||
    line === undefined ||
    moreLines.length > 0 ||
    line.product_id !== productId ||
    line.quantity !== 1 ||
    line.subtotal !== sold.goods ||
    line.total !== sold.goods ||
    line.total_tax !== "0.00" ||
    carriage === undefined ||
    moreCarriage.length > 0 ||
    carriage.method_id !== sold.rate.methodId ||
    String(carriage.instance_id) !== sold.rate.instanceId ||
    carriage.total !== sold.rate.cost ||
    made.payment_method !== "agentify" ||
    made.transaction_id !== sold.orderId ||
    made.billing.email !== sold.email ||
    orderIds.length !== 1 ||
    orderIds[0] !== sold.orderId ||
    !heldWhereItGoes
  ) {
    return {
      ok: false,
      why:
        "The shop created an order whose paid amount, product, shipping or Agentify correlation" +
        " does not match the sale.",
      again: true,
      id: String(made.id),
    };
  }
  return { ok: true, id: String(made.id), number: String(made.number) };
};

const ParcelOrderSchema = z.looseObject({
  id: z.number().int().positive(),
  number: z.union([z.string().min(1), z.number().int().positive()]),
  status: z.string(),
  currency: z.string(),
  total: z.string(),
  total_tax: z.string(),
  payment_method: z.string(),
  transaction_id: z.string(),
  billing: z.looseObject({ email: z.string() }),
  shipping: z.record(z.string(), z.unknown()).optional(),
  meta_data: z.array(z.looseObject({ key: z.string(), value: z.unknown() })),
  line_items: z.array(
    z.looseObject({
      product_id: z.number().int().positive(),
      quantity: z.number().int().positive(),
      subtotal: z.string(),
      total: z.string(),
      total_tax: z.string(),
    }),
  ),
  shipping_lines: z.array(
    z.looseObject({
      method_id: z.string(),
      instance_id: z.union([z.string(), z.number().int()]),
      total: z.string(),
    }),
  ),
});

export type ShipmentRead =
  /** Paid and waiting to be sent, or held. */
  | { readonly kind: "waiting" }
  | { readonly kind: "shipped"; readonly shipment: Shipment }
  /** Ended without completing, or the order is gone. */
  | { readonly kind: "ended"; readonly status: string }
  /** The shop did not answer, or said something unclear. */
  | { readonly kind: "unknown"; readonly why: string };

const ENDED_UNSHIPPED = new Set(["cancelled", "refunded", "failed", "trash"]);

const FollowedOrderSchema = z.looseObject({
  status: z.string(),
  transaction_id: z.string(),
  shipping_lines: z.array(z.looseObject({ method_title: z.string() })),
});

const FulfilmentsSchema = z.array(
  z.looseObject({
    status: z.string(),
    meta_data: z.array(z.looseObject({ key: z.string(), value: z.unknown() })),
  }),
);

/**
 * WooCommerce has no "shipped": completed is the merchant's word that the order
 * needs nothing more, and is read as sent. Tracking comes from WooCommerce's
 * own fulfilments where switched on and fulfilled; otherwise the carrier is the
 * shipping method paid for, with no tracking number. The fields read leave the
 * address out. What the merchant wrote is never cleaned: a tracking address
 * that is not one is dropped, and a carrier or number that is not plain text is
 * no shipment, so the order waits.
 */
export const shipmentInTheShop = async (
  keys: ShopKeys,
  wooOrderId: string,
  orderId: string,
  request: WooRequest = wooRequest,
): Promise<ShipmentRead> => {
  if (!/^\d+$/.test(wooOrderId)) {
    return { kind: "unknown", why: "The shop's order number is not a WooCommerce order id." };
  }
  /** Null where the shop did not answer. */
  const read = async (path: string): Promise<{ status: number; body: unknown } | null> => {
    try {
      const response = await request(`${keys.shopUrl}${path}`, {
        headers: { authorization: basicFor(keys), accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
      });
      const said = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(said);
      } catch {
        body = undefined;
      }
      return { status: response.status, body };
    } catch {
      return null;
    }
  };
  const codeOf = (body: unknown): unknown =>
    typeof body === "object" && body !== null && "code" in body ? body.code : undefined;

  const order = await read(
    `/wp-json/wc/v3/orders/${wooOrderId}?_fields=id,status,transaction_id,shipping_lines`,
  );
  if (order === null) return { kind: "unknown", why: "The shop did not answer." };
  if (order.status === 404 && codeOf(order.body) === "woocommerce_rest_shop_order_invalid_id") {
    return { kind: "ended", status: "deleted" };
  }
  if (order.status !== 200) {
    return { kind: "unknown", why: `The shop answered the order read with HTTP ${order.status}.` };
  }
  const followed = FollowedOrderSchema.safeParse(order.body);
  if (!followed.success) {
    return { kind: "unknown", why: "The shop's order is not one this can read." };
  }
  // The shop's order id can be reused (another shop connected, or this one
  // rebuilt), so only an order carrying this sale's own identifier is this
  // sale's.
  if (followed.data.transaction_id !== orderId) {
    return { kind: "unknown", why: `The shop's order ${wooOrderId} is not this sale's.` };
  }
  if (ENDED_UNSHIPPED.has(followed.data.status)) {
    return { kind: "ended", status: followed.data.status };
  }
  if (followed.data.status !== "completed") return { kind: "waiting" };

  const fulfilments = await read(`/wp-json/wc/v3/orders/${wooOrderId}/fulfillments`);
  if (fulfilments === null) return { kind: "unknown", why: "The shop did not answer." };
  let fulfilled: readonly { readonly key: string; readonly value: unknown }[][] = [];
  if (fulfilments.status === 404 && codeOf(fulfilments.body) === "rest_no_route") {
    // WooCommerce's own fulfilments are off, its default.
  } else if (fulfilments.status !== 200) {
    return {
      kind: "unknown",
      why: `The shop answered the fulfilments read with HTTP ${fulfilments.status}.`,
    };
  } else {
    const listed = FulfilmentsSchema.safeParse(fulfilments.body);
    if (!listed.success) {
      return { kind: "unknown", why: "The shop's fulfilments are not ones this can read." };
    }
    fulfilled = listed.data.filter((one) => one.status === "fulfilled").map((one) => one.meta_data);
  }
  if (fulfilled.length > 1) {
    return {
      kind: "unknown",
      why: "The order has several fulfilments, and one parcel ships once.",
    };
  }
  const meta = (key: string): string | null => {
    const value = fulfilled[0]?.find((one) => one.key === key)?.value;
    return typeof value === "string" && value !== "" ? value : null;
  };
  const lines = followed.data.shipping_lines;
  const carrier =
    meta("_shipment_provider") ?? (lines.length === 1 ? lines[0]?.method_title : null);
  if (carrier === null || carrier === undefined) {
    return { kind: "unknown", why: "The order names no one carrier and no one shipping method." };
  }
  const said = ShipmentSchema.safeParse({ carrier, tracking_number: meta("_tracking_number") });
  if (!said.success) {
    return {
      kind: "unknown",
      why: "The order's carrier or tracking number is not plain text an agent can read.",
    };
  }
  const address = meta("_tracking_url");
  const followable =
    address === null ? null : ShipmentSchema.safeParse({ ...said.data, tracking_url: address });
  return {
    kind: "shipped",
    shipment: followable?.success === true ? followable.data : said.data,
  };
};

/** Never scans, and never infers that no order exists. */
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
 * 5xx, 429 and 408 all mean "ask again in a moment"; read as final, they would
 * close a sale for good over a shop's busy afternoon. Anything else is the shop
 * having read the request and said no, which it will say again.
 */
const worthAskingAgain = (status: number): boolean =>
  status >= 500 || status === 408 || status === 429;

const basicFor = (keys: ShopKeys): string =>
  `Basic ${Buffer.from(`${keys.consumerKey}:${keys.consumerSecret}`).toString("base64")}`;

/**
 * A proxy or firewall in between can answer with a page of its own, so this
 * falls back to the status rather than parsing its way into an exception.
 */
const whatTheShopSaid = (said: string, status: number): string => {
  try {
    const body = JSON.parse(said) as { message?: unknown };
    if (typeof body.message === "string" && body.message !== "") {
      return body.message;
    }
  } catch {
    // Not a document; the status is all that is known.
  }
  return `the answer carried no message we could read (HTTP ${status}).`;
};
