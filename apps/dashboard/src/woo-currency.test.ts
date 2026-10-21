/**
 * A sale from a WooCommerce shop priced in another currency, from the shop's
 * answers to the order in the shop: the shop is read and held to its own
 * amounts in its own currency at its own decimals, and the buyer pays the US
 * dollars the merchant's rate gives. The shop is the lab's realistic rupiah
 * shop as `wc/v3` and the Store API answer for it, at no decimals; the rate is
 * the merchant's own, 18000 rupiah to the dollar.
 */

import type { Order } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { merchantItemIdFor } from "./woo-catalog.js";
import type { WooRequest } from "./woo-request.js";
import {
  createTheOrderInTheShop,
  createTheParcelInTheShop,
  type EligibleWooProduct,
  inspectProductInTheShop,
  type OrderMade,
  type ParcelMade,
  type ParcelSold,
  type RatesRead,
  type SoldItem,
  shippingRatesInTheShop,
} from "./woo-shop.js";
import { memoryWooShops, type RateEntry, type WooConnection, type WooShops } from "./woo-shops.js";
import { type Filling, fillFromTheShop, quoteFromTheShop } from "./woo-worker.js";

const SHOP = "https://shop.example.com";
const EMAIL = "merchant@example.com";
const NOW = new Date("2026-10-21T12:00:00.000Z");
const SET = new Date("2026-10-09T10:00:00.000Z");
const RATE: RateEntry = {
  currency: "IDR",
  rate: "18000",
  setAt: SET,
  setBy: "owner@example.com",
  reference: { rate: "18035.292596", source: "Coinbase", readAt: SET },
  confirmed: false,
};
const KEYS = { shopUrl: SHOP, consumerKey: "ck_abc", consumerSecret: "cs_def" };
const CONNECTION: WooConnection = {
  accountId: "acc_1",
  ...KEYS,
  permissions: "read_write",
  revision: "grant_1",
  connectedAt: NOW,
  currency: { code: "IDR", decimals: 0 },
};

/** The lab's batik tote at Rp 250.000, sold as a download from a shop with tax off. */
const settingsOf = (currency: string, decimals: string): Readonly<Record<string, string>> => ({
  woocommerce_currency: currency,
  woocommerce_price_num_decimals: decimals,
  woocommerce_calc_taxes: "no",
  woocommerce_file_download_method: "force",
  woocommerce_downloads_require_login: "no",
  woocommerce_downloads_grant_access_after_payment: "yes",
  woocommerce_downloads_redirect_fallback_allowed: "no",
  woocommerce_ship_to_countries: "",
  woocommerce_ship_to_destination: "shipping",
});

const aShopIn =
  (currency: string, decimals: string, price = "250000", parcel = false): WooRequest =>
  async (url) => {
    const at = new URL(url).pathname;
    if (at === "/protected/batik.pdf") return new Response("", { status: 403 });
    const setting = at.split("/").at(-1) ?? "";
    if (at.includes("/settings/")) {
      return Response.json({ id: setting, value: settingsOf(currency, decimals)[setting] ?? "" });
    }
    return Response.json({
      id: 41,
      type: "simple",
      status: "publish",
      purchasable: true,
      stock_status: "instock",
      manage_stock: false,
      sold_individually: false,
      virtual: !parcel,
      downloadable: !parcel,
      download_limit: -1,
      download_expiry: -1,
      price,
      downloads: parcel
        ? []
        : [{ id: "dl_batik", name: "Batik pattern.pdf", file: `${SHOP}/protected/batik.pdf` }],
    });
  };

const ITEM = merchantItemIdFor(SHOP, "41");

describe("the shop's product, read from a shop priced in rupiah", () => {
  it("is sold at the shop's own price in its own currency, at no decimals", async () => {
    const read = await inspectProductInTheShop(KEYS, ITEM, aShopIn("IDR", "0"));

    expect(read).toMatchObject({
      ok: true,
      product: { kind: "download", price: { amount: "250000", currency: "IDR" } },
    });
  });

  it("is refused from a shop that writes three decimals, naming the setting", async () => {
    const read = await inspectProductInTheShop(KEYS, ITEM, aShopIn("KWD", "3", "75.000"));

    expect(read).toMatchObject({
      ok: false,
      saidNo: true,
      why: expect.stringContaining("Number of decimals"),
    });
  });

  it("is refused from a dollar shop at no decimals, as it always was", async () => {
    const read = await inspectProductInTheShop(KEYS, ITEM, aShopIn("USD", "0", "25"));

    expect(read).toMatchObject({ ok: false, why: expect.stringContaining("Number of decimals") });
  });

  it("is another product once the shop's currency changes, at the same digits", async () => {
    const inRupiah = await inspectProductInTheShop(KEYS, ITEM, aShopIn("IDR", "0"));
    const inYen = await inspectProductInTheShop(KEYS, ITEM, aShopIn("JPY", "0"));

    expect(inRupiah.ok && inYen.ok).toBe(true);
    expect(inRupiah.ok && inYen.ok && inRupiah.product.fingerprint).not.toBe(
      inYen.ok && inYen.product.fingerprint,
    );
  });
});

/** A wc/v3 order answer echoing what was sent, totalled at `total`. */
const aShopTotalling =
  (total: string, sent: unknown[] = []): WooRequest =>
  async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      currency: string;
      transaction_id: string;
      billing: unknown;
      shipping?: unknown;
      meta_data: unknown;
      line_items: { product_id: number; subtotal?: string; total?: string }[];
      shipping_lines?: { method_id: string; instance_id: string; total: string }[];
    };
    sent.push(body);
    return Response.json(
      {
        id: 77,
        number: "77",
        order_key: "wc_order_77",
        status: "processing",
        currency: body.currency,
        total,
        total_tax: "0",
        payment_method: "agentify",
        transaction_id: body.transaction_id,
        billing: body.billing,
        shipping: body.shipping,
        meta_data: body.meta_data,
        line_items: body.line_items.map((line) => ({
          product_id: line.product_id,
          quantity: 1,
          subtotal: line.subtotal,
          total: line.total,
          total_tax: "0",
        })),
        shipping_lines: body.shipping_lines ?? [],
      },
      { status: 201 },
    );
  };

const SOLD: SoldItem = {
  orderId: "ord_idr",
  productId: "41",
  email: EMAIL,
  price: { amount: "250000", currency: "IDR" },
  download: { id: "dl_batik", name: "Batik pattern.pdf" },
  paidInto: null,
  tax: { mode: "off" },
  converted: {
    paid: { amount: "13.89", currency: "USD" },
    rate: { version: 3, currency: "IDR", rate: "18000", setAt: SET },
  },
};

describe("the shop's order for a sale converted at the merchant's rate", () => {
  it("is made in the shop's currency at its own amount, and carries the dollars paid and the rate", async () => {
    const sent: unknown[] = [];
    const made = await createTheOrderInTheShop(KEYS, SOLD, aShopTotalling("250000", sent));

    expect(made).toMatchObject({ ok: true, total: "250000" });
    expect(sent[0]).toMatchObject({
      currency: "IDR",
      line_items: [{ product_id: 41, quantity: 1, subtotal: "250000", total: "250000" }],
      meta_data: [
        { key: "agentify_order_id", value: "ord_idr" },
        { key: "agentify_paid", value: "13.89 USD" },
        { key: "agentify_shop_amount", value: "250000 IDR" },
        {
          key: "agentify_rate",
          value: "18000 IDR per USD, rate 3, set 2026-10-09T10:00:00.000Z",
        },
      ],
    });
  });

  it("is taken on a rupiah either side of the amount, and not two", async () => {
    for (const total of ["250001", "249999"]) {
      expect(await createTheOrderInTheShop(KEYS, SOLD, aShopTotalling(total)), total).toMatchObject(
        { ok: true, total },
      );
    }
    for (const total of ["250002", "249998", "250000.00"]) {
      expect(await createTheOrderInTheShop(KEYS, SOLD, aShopTotalling(total)), total).toMatchObject(
        { ok: false },
      );
    }
  });

  it("is a parcel's order at the goods and the shop's own rupiah rate, held to their sum", async () => {
    const parcel: ParcelSold = {
      orderId: "ord_parcel",
      productId: "41",
      email: EMAIL,
      total: { amount: "274000", currency: "IDR" },
      goods: "250000",
      tax: "off",
      rate: { methodId: "flat_rate", instanceId: "1", title: "Flat rate", cost: "24000", tax: "0" },
      address: {
        name: "Ni Made Ayu",
        line_one: "Jl. Raya Ubud No. 8",
        city: "Gianyar",
        state: "BA",
        postal_code: "80571",
        country: "ID",
        phone_number: "+62361975000",
      },
      paidInto: null,
      converted: {
        paid: { amount: "15.23", currency: "USD" },
        rate: { version: 3, currency: "IDR", rate: "18000", setAt: SET },
      },
    };
    const sent: unknown[] = [];

    const made = await createTheParcelInTheShop(KEYS, parcel, aShopTotalling("274001", sent));

    expect(made).toMatchObject({ ok: true, total: "274001" });
    expect(sent[0]).toMatchObject({
      currency: "IDR",
      line_items: [{ subtotal: "250000", total: "250000" }],
      shipping_lines: [{ total: "24000" }],
    });
    expect(await createTheParcelInTheShop(KEYS, parcel, aShopTotalling("274002"))).toMatchObject({
      ok: false,
    });
  });
});

describe("the shop's cart, priced in rupiah", () => {
  it("names the currency it priced in, and its rates at no decimals", async () => {
    const cart: WooRequest = async (url, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({}, { headers: { "Cart-Token": "cart-1" } });
      }
      return Response.json(
        {
          items: [{ key: "line-41", id: 41, quantity: 1 }],
          errors: [],
          needs_shipping: true,
          shipping_rates: [
            {
              package_id: 0,
              items: [{ key: "line-41", quantity: 1 }],
              shipping_rates: [
                {
                  rate_id: "flat_rate:1",
                  name: "Flat rate",
                  method_id: "flat_rate",
                  instance_id: 1,
                  price: "24000",
                  taxes: "0",
                  currency_code: "IDR",
                  currency_minor_unit: 0,
                  selected: true,
                },
              ],
            },
          ],
        },
        { status: new URL(url).pathname.endsWith("/add-item") ? 201 : 200 },
      );
    };

    const read = await shippingRatesInTheShop(
      SHOP,
      "41",
      { country: "ID", state: "BA", city: "Gianyar", postal_code: "80571" },
      cart,
    );

    expect(read).toMatchObject({
      ok: true,
      currency: "IDR",
      rates: [{ cost: "24000", tax: "0" }],
    });
  });
});

const A_DOWNLOAD: EligibleWooProduct = {
  kind: "download",
  productId: "41",
  downloadId: "dl_batik",
  fileName: "Batik pattern.pdf",
  price: { amount: "250000", currency: "IDR" },
  tax: { mode: "off" },
  fingerprint: "batik-in-rupiah",
};

const QUESTION = {
  price_id: "prc_idr",
  purpose: "purchase" as const,
  merchant_item_id: ITEM,
  expires_at: "2026-10-21T12:00:30.000Z",
};

const anOrder = (overrides: Partial<Order> = {}): Order => ({
  id: "ord_idr",
  merchant_item_id: ITEM,
  params: {},
  price: {
    amount: "13.89",
    currency: "USD",
    at: NOW.toISOString(),
    as_of: NOW.toISOString(),
  },
  price_id: "prc_idr",
  test: true,
  ...overrides,
});

const parts = (
  shops: WooShops,
  product: EligibleWooProduct = A_DOWNLOAD,
  placed: SoldItem[] = [],
): Filling => ({
  shops,
  now: () => NOW,
  inspectProduct: async () => ({ ok: true, product }),
  placeOrder: async (_keys, sold): Promise<OrderMade> => {
    placed.push(sold);
    return {
      ok: true,
      id: "77",
      number: "77",
      orderKey: "wc_order_77",
      downloadId: sold.download.id,
      total: sold.price.amount,
    };
  },
});

describe("a price question for a card from a shop priced in rupiah", () => {
  it("is answered in US dollars at the merchant's current rate, bound to the rupiah amount and the rate", async () => {
    const shops = memoryWooShops();
    const rate = await shops.saveRate("acc_1", SHOP, RATE);

    const answer = await quoteFromTheShop(CONNECTION, QUESTION, NOW, parts(shops));

    expect(answer).toEqual({
      available: true,
      price: { amount: "13.89", currency: "USD" },
      as_of: NOW.toISOString(),
    });
    expect(await shops.quotedSale("acc_1", "prc_idr", ITEM)).toEqual({
      fingerprint: "batik-in-rupiah",
      inTheShop: { amount: "250000", currency: "IDR" },
      paid: { amount: "13.89", currency: "USD" },
      rate: { version: rate.version, currency: "IDR", rate: "18000", setAt: SET },
    });
  });

  it("is not available, and binds nothing, while no rate is set", async () => {
    const shops = memoryWooShops();

    const answer = await quoteFromTheShop(CONNECTION, QUESTION, NOW, parts(shops));

    expect(answer).toEqual({ available: false, as_of: NOW.toISOString() });
    expect(await shops.quotedSale("acc_1", "prc_idr", ITEM)).toBeNull();
  });

  it("is not available once the shop sells in another currency than its rate was set for", async () => {
    const shops = memoryWooShops();
    await shops.saveRate("acc_1", SHOP, RATE);
    const inEuros = { ...A_DOWNLOAD, price: { amount: "14.50", currency: "EUR" } };

    const answer = await quoteFromTheShop(CONNECTION, QUESTION, NOW, parts(shops, inEuros));

    expect(answer).toEqual({ available: false, as_of: NOW.toISOString() });
  });

  it("prices a parcel at the goods and the shop's cheapest rupiah rate, converted once", async () => {
    const shops = memoryWooShops();
    await shops.saveRate("acc_1", SHOP, RATE);
    const tote: EligibleWooProduct = {
      kind: "parcel",
      productId: "41",
      price: { amount: "250000", currency: "IDR" },
      tax: { mode: "off" },
      fingerprint: "tote-in-rupiah",
    };
    const rates: RatesRead = {
      ok: true,
      currency: "IDR",
      rates: [
        { methodId: "flat_rate", instanceId: "2", title: "Express", cost: "48000", tax: "0" },
        { methodId: "flat_rate", instanceId: "1", title: "Flat rate", cost: "24000", tax: "0" },
      ],
      priced: { ok: false, why: "untaxed", again: false, saidNo: false },
    };

    const answer = await quoteFromTheShop(
      CONNECTION,
      { ...QUESTION, ship_to: { country: "ID", state: "BA", city: "Gianyar" } },
      NOW,
      { ...parts(shops, tote), shippingRates: async () => rates },
    );

    // 274000 / 18000 = 15.2222…, rounded up.
    expect(answer).toMatchObject({ available: true, price: { amount: "15.23", currency: "USD" } });
    expect(await shops.quotedSale("acc_1", "prc_idr", ITEM)).toMatchObject({
      inTheShop: { amount: "274000", currency: "IDR" },
    });
  });
});

describe("a parcel's price where the shop's cart answers in another currency than its product", () => {
  it("is not available, rather than adding yen of shipping to rupiah goods", async () => {
    const shops = memoryWooShops();
    await shops.saveRate("acc_1", SHOP, RATE);
    const tote: EligibleWooProduct = {
      kind: "parcel",
      productId: "41",
      price: { amount: "250000", currency: "IDR" },
      tax: { mode: "off" },
      fingerprint: "tote-in-rupiah",
    };
    const inYen = async (): Promise<RatesRead> => ({
      ok: true,
      currency: "JPY",
      rates: [{ methodId: "flat_rate", instanceId: "1", title: "Flat", cost: "500", tax: "0" }],
      priced: { ok: false, why: "untaxed", again: false, saidNo: false },
    });

    const answer = await quoteFromTheShop(
      CONNECTION,
      { ...QUESTION, ship_to: { country: "ID", state: "BA", city: "Gianyar" } },
      NOW,
      { ...parts(shops, tote), shippingRates: inYen },
    );

    expect(answer).toEqual({ available: false, as_of: NOW.toISOString() });
  });
});

describe("a paid order for a card from a shop priced in rupiah", () => {
  const quoted = async (shops: WooShops) => {
    await shops.saveRate("acc_1", SHOP, RATE);
    await quoteFromTheShop(CONNECTION, QUESTION, NOW, parts(shops));
  };

  it("makes the shop's order at the rupiah amount bound to the price, and records the rate in the ledger", async () => {
    const shops = memoryWooShops();
    await quoted(shops);
    const placed: SoldItem[] = [];

    const answer = await fillFromTheShop(
      anOrder(),
      CONNECTION,
      EMAIL,
      parts(shops, A_DOWNLOAD, placed),
      null,
    );

    expect(answer).toMatchObject({ delivered: { order_number: "77" } });
    expect(placed).toMatchObject([
      {
        price: { amount: "250000", currency: "IDR" },
        converted: { paid: { amount: "13.89", currency: "USD" }, rate: { rate: "18000" } },
      },
    ]);
    expect(await shops.shopTotals("acc_1", ["ord_idr"])).toMatchObject({
      ord_idr: {
        total: "250000",
        converted: {
          inTheShop: { amount: "250000", currency: "IDR" },
          rate: { rate: "18000", setAt: SET.toISOString() },
        },
      },
    });
  });

  it("holds the order to the rate bound at the price, though the merchant set another since", async () => {
    const shops = memoryWooShops();
    await quoted(shops);
    await shops.saveRate("acc_1", SHOP, { ...RATE, rate: "16000", setAt: NOW });
    const placed: SoldItem[] = [];

    await fillFromTheShop(anOrder(), CONNECTION, EMAIL, parts(shops, A_DOWNLOAD, placed), null);

    expect(placed).toMatchObject([
      { price: { amount: "250000" }, converted: { rate: { rate: "18000", setAt: SET } } },
    ]);
  });

  it("is refused before the shop is asked when what was paid is not the dollars bound to the price", async () => {
    const shops = memoryWooShops();
    await quoted(shops);
    const placed: SoldItem[] = [];

    const answer = await fillFromTheShop(
      anOrder({ price: { ...anOrder().price, amount: "13.88" } }),
      CONNECTION,
      EMAIL,
      parts(shops, A_DOWNLOAD, placed),
      null,
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(placed).toEqual([]);
  });

  it("is refused before the shop is asked once the product's rupiah price is not the one bound", async () => {
    const shops = memoryWooShops();
    await quoted(shops);
    const placed: SoldItem[] = [];
    const repriced = { ...A_DOWNLOAD, price: { amount: "260000", currency: "IDR" } };

    const answer = await fillFromTheShop(
      anOrder(),
      CONNECTION,
      EMAIL,
      parts(shops, repriced, placed),
      null,
    );

    expect(answer).toMatchObject({ refused: { code: "cannot_fulfill" } });
    expect(placed).toEqual([]);
  });

  it("makes a parcel's order at the bound rupiah total with the rate that makes it up", async () => {
    const shops = memoryWooShops();
    await shops.saveRate("acc_1", SHOP, RATE);
    const tote: EligibleWooProduct = {
      kind: "parcel",
      productId: "41",
      price: { amount: "250000", currency: "IDR" },
      tax: { mode: "off" },
      fingerprint: "tote-in-rupiah",
    };
    const rates = async (): Promise<RatesRead> => ({
      ok: true,
      currency: "IDR",
      rates: [
        { methodId: "flat_rate", instanceId: "2", title: "Express", cost: "48000", tax: "0" },
        { methodId: "flat_rate", instanceId: "1", title: "Flat rate", cost: "24000", tax: "0" },
      ],
      priced: { ok: false, why: "untaxed", again: false, saidNo: false },
    });
    const place = { country: "ID", state: "BA", city: "Gianyar", postal_code: "80571" };
    const placed: ParcelSold[] = [];
    const filling: Filling = {
      ...parts(shops, tote),
      shippingRates: rates,
      placeParcel: async (_keys, sold): Promise<ParcelMade> => {
        placed.push(sold);
        return { ok: true, id: "78", number: "78", total: sold.total.amount };
      },
    };
    await quoteFromTheShop(CONNECTION, { ...QUESTION, ship_to: place }, NOW, filling);

    const answer = await fillFromTheShop(
      anOrder({
        price: { ...anOrder().price, amount: "15.23" },
        ship_to: {
          name: "Ni Made Ayu",
          line_one: "Jl. Raya Ubud No. 8",
          phone_number: "+62361975000",
          ...place,
        },
      }),
      CONNECTION,
      EMAIL,
      filling,
      null,
    );

    expect(answer).toEqual({ accepted: {} });
    expect(placed).toMatchObject([
      {
        total: { amount: "274000", currency: "IDR" },
        goods: "250000",
        rate: { cost: "24000" },
        converted: { paid: { amount: "15.23", currency: "USD" } },
      },
    ]);
  });
});
