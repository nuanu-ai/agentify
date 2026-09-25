/**
 * The converter between a WooCommerce shop's own catalogue and our cards.
 *
 * The scale test is the one that matters most and it is why this file exists
 * before the screens do. A Store API price is a string of minor units with the
 * scale beside it — `"12000"` at `currency_minor_unit: 2` is a hundred and
 * twenty dollars — and a converter that reads the number without the scale is
 * wrong by a factor of a hundred, quietly, on every ordinary currency
 * (`docs/research/33-woo-connect-probe.md`). Wrong in the direction that sells
 * a hundred-and-twenty-dollar product for one dollar twenty, or asks for twelve
 * thousand.
 */

import { CardSchema } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import {
  cardsFromTheShop,
  decimalOfMinorUnits,
  plainTextOf,
  type StoreProduct,
} from "./woo-catalog.js";

/** One Store API product, with the awkward parts overridable per test. */
const product = (overrides: Partial<StoreProduct> = {}): StoreProduct => ({
  id: 11,
  name: "Canvas tote bag",
  sku: "agentify-tote",
  type: "simple",
  description: "<p>A physical item that has to be shipped somewhere.</p>\n",
  short_description: "<p>Physical goods, shipped.</p>\n",
  is_purchasable: true,
  is_in_stock: true,
  status: "publish",
  virtual: true,
  downloadable: true,
  manage_stock: false,
  download_limit: -1,
  download_expiry: -1,
  downloads: [
    {
      id: "dl_owned_guide",
      name: "Agentify acceptance guide.txt",
      file: "https://shop.example.com/wp-content/uploads/woocommerce_uploads/guide.txt",
    },
  ],
  qualification_problem: null,
  prices: {
    price: "2500",
    currency_code: "USD",
    currency_minor_unit: 2,
  },
  ...overrides,
});

describe("a price in minor units", () => {
  it("reads the scale the shop sent beside the number", () => {
    expect(decimalOfMinorUnits("12000", 2)).toBe("120.00");
    expect(decimalOfMinorUnits("2500", 2)).toBe("25.00");
    expect(decimalOfMinorUnits("500", 2)).toBe("5.00");
  });

  it("is the number itself where the currency has no minor unit", () => {
    // Yen and the like. A scale of zero is a real answer and not a missing one,
    // so it must not be treated as "assume two".
    expect(decimalOfMinorUnits("500", 0)).toBe("500");
    expect(decimalOfMinorUnits("0", 0)).toBe("0");
  });

  it("pads a number shorter than its own scale", () => {
    expect(decimalOfMinorUnits("5", 2)).toBe("0.05");
    expect(decimalOfMinorUnits("50", 2)).toBe("0.50");
    expect(decimalOfMinorUnits("0", 2)).toBe("0.00");
    expect(decimalOfMinorUnits("1", 3)).toBe("0.001");
  });

  it("carries a scale that is not two", () => {
    // Three minor digits is the case a converter written against dollars gets
    // wrong by a factor of ten rather than a hundred, which is the size of
    // mistake nobody notices in a list.
    expect(decimalOfMinorUnits("1234", 3)).toBe("1.234");
    expect(decimalOfMinorUnits("1234", 4)).toBe("0.1234");
  });

  it("is an amount our own contract accepts", () => {
    // The point of the converter is a card that publishes, so what comes out
    // is held to the rule the publish door holds a price to rather than to a
    // shape written out here.
    for (const [minor, scale] of [
      ["12000", 2],
      ["5", 2],
      ["500", 0],
      ["1234", 3],
    ] as const) {
      const written = decimalOfMinorUnits(minor, scale);
      expect(written).not.toBeNull();
      expect(
        CardSchema.safeParse({
          merchant_item_id: "1",
          title: "A title",
          description: "A description.",
          price: { amount: written, currency: "USD" },
          result: { order_number: "string" },
        }).success,
      ).toBe(true);
    }
  });

  it("says nothing about a number it cannot read", () => {
    // Null rather than a guess. Every one of these would otherwise become a
    // price on a card somebody sells at.
    expect(decimalOfMinorUnits("", 2)).toBeNull();
    expect(decimalOfMinorUnits("12.00", 2)).toBeNull();
    expect(decimalOfMinorUnits("-500", 2)).toBeNull();
    expect(decimalOfMinorUnits("1e3", 2)).toBeNull();
    expect(decimalOfMinorUnits("500", -1)).toBeNull();
    expect(decimalOfMinorUnits("500", 1.5)).toBeNull();
    expect(decimalOfMinorUnits("500", 1_000_000_000)).toBeNull();
  });
});

describe("the shop's own prose", () => {
  it("comes out as text rather than as markup", () => {
    expect(plainTextOf("<p>A single-use access code <em>by email</em>.</p>")).toBe(
      "A single-use access code by email.",
    );
  });

  it("puts the characters back that the shop wrote as entities", () => {
    expect(plainTextOf("Tea &amp; coffee &#8212; &quot;the set&quot;")).toBe(
      'Tea & coffee — "the set"',
    );
  });

  it("reads a character written as a hexadecimal reference", () => {
    expect(plainTextOf("Caf&#xE9; brunch")).toBe("Café brunch");
  });

  it("leaves a name it does not know as it arrived", () => {
    // An HTML 4 name the table lacks, typed by hand, which wp_kses_post passes
    // through. Not dropped and not guessed at: what the card says can always
    // be traced back to what the shop sent.
    expect(plainTextOf("Caf&eacute; brunch")).toBe("Caf&eacute; brunch");
  });

  it("reads each reference once", () => {
    // What the shop sends for a merchant who typed the six characters `&#038;`
    // into their prose. Read twice, it would show an ampersand they never
    // wrote.
    expect(plainTextOf("Type &amp;#038; for an ampersand")).toBe("Type &#038; for an ampersand");
  });

  it("keeps a tag the merchant wrote as text", () => {
    // The markup goes before the references are read. The other way round, a
    // tag spelled out in the prose becomes a tag and is removed with the rest.
    expect(plainTextOf("<p>Adds a &lt;header&gt; block to the theme.</p>")).toBe(
      "Adds a <header> block to the theme.",
    );
  });

  it("drops what a browser would not have shown either", () => {
    expect(plainTextOf("<script>alert(1)</script><p>Real text.</p>")).toBe("Real text.");
    expect(plainTextOf("<style>p{color:red}</style>Real text.")).toBe("Real text.");
  });

  it("is empty for prose that was only markup", () => {
    expect(plainTextOf("<p>&nbsp;</p>")).toBe("");
    expect(plainTextOf("")).toBe("");
  });
});

describe("turning a shop's products into cards", () => {
  it("carries the price through at the scale the shop sent", () => {
    const { cards } = cardsFromTheShop([
      product({ prices: { price: "12000", currency_code: "USD", currency_minor_unit: 2 } }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.card.price).toEqual({ amount: "120.00", currency: "USD" });
  });

  it("binds the card to the shop origin as well as its product identifier", () => {
    const { cards } = cardsFromTheShop([product({ id: 42 })], "https://shop.example.com");
    expect(cards[0]?.card.merchant_item_id).toMatch(/^woo_[a-f0-9]{16}_42$/);
    const other = cardsFromTheShop([product({ id: 42 })], "https://other.example.com");
    expect(other.cards[0]?.card.merchant_item_id).not.toBe(cards[0]?.card.merchant_item_id);
  });

  it("takes the title and the description off the product", () => {
    const { cards } = cardsFromTheShop([product()]);
    expect(cards[0]?.card.title).toBe("Canvas tote bag");
    expect(cards[0]?.card.description).toBe("A physical item that has to be shipped somewhere.");
  });

  it("titles the card with the name the shop shows rather than the references it is sent in", () => {
    // The Store API passes a product name through wptexturize and
    // convert_chars, so the ampersand a merchant typed arrives as `&#038;` and
    // an apostrophe as `&#8217;`. The first name is the one a live shop serves.
    const { cards } = cardsFromTheShop([
      product({ id: 12, name: "Coffee &#038; Brunch Gift Card" }),
      product({ id: 13, name: "Chef&#8217;s Table Gift Card" }),
      product({ id: 14, name: "Dinner for Two Gift Card" }),
    ]);
    expect(cards.map((one) => one.card.title)).toEqual([
      "Coffee & Brunch Gift Card",
      "Chef’s Table Gift Card",
      "Dinner for Two Gift Card",
    ]);
    expect(cards.map((one) => one.title)).toEqual(cards.map((one) => one.card.title));
  });

  it("describes the card in the characters the shop's page shows", () => {
    const { cards } = cardsFromTheShop([
      product({
        description: "<p>Coffee &amp; brunch for two.&nbsp;Valid for twelve months.</p>\n",
      }),
    ]);
    expect(cards[0]?.card.description).toBe("Coffee & brunch for two. Valid for twelve months.");
  });

  it("falls back to the short description where there is no other", () => {
    const { cards } = cardsFromTheShop([product({ description: "" })]);
    expect(cards[0]?.card.description).toBe("Physical goods, shipped.");
  });

  it("declares the native download the agent is handed", () => {
    const { cards } = cardsFromTheShop([product()]);
    expect(cards[0]?.card.result).toEqual({
      download_url: { type: "string", title: "The private WooCommerce download address" },
      file_name: { type: "string", title: "The name of the downloadable file" },
      order_number: { type: "string", title: "The number this order has in the shop" },
    });
    expect(cards[0]?.card.fulfillment).toBe("async");
    expect(cards[0]?.card.price_check).toBe("handler");
  });

  it("makes a card our own publish door recognises", () => {
    const { cards } = cardsFromTheShop([product()]);
    expect(CardSchema.safeParse(cards[0]?.card).success).toBe(true);
  });

  it("does not shorten a description the shop wrote long", () => {
    // The door refuses a description over five hundred characters and the
    // merchant reads that refusal. Cutting it here would publish prose the
    // merchant never wrote under their own name.
    const long = "a".repeat(900);
    const { cards } = cardsFromTheShop([product({ description: `<p>${long}</p>` })]);
    expect(cards[0]?.card.description).toHaveLength(900);
  });

  it("names the setting for a price at another scale, and the currency for another currency", () => {
    // A whole-dollar shop is not fixed by retyping its prices with cents, so
    // the refusal names the one setting that changes the scale. A shop in
    // euros is not fixed by that setting, so its refusal does not name it.
    const { skipped } = cardsFromTheShop([
      product({ id: 1, prices: { price: "25", currency_code: "USD", currency_minor_unit: 0 } }),
      product({ id: 2, prices: { price: "2500", currency_code: "EUR", currency_minor_unit: 2 } }),
    ]);

    const why = Object.fromEntries(skipped.map((one) => [one.id, one.why]));
    expect(why["1"]).toContain("Number of decimals");
    expect(why["2"]).toContain("EUR");
    expect(why["2"]).not.toContain("Number of decimals");
  });

  it("leaves a product it cannot map alone and says why", () => {
    const { cards, skipped } = cardsFromTheShop([
      product({ id: 1, type: "variable" }),
      product({ id: 2, is_purchasable: false }),
      product({ id: 3, is_in_stock: false }),
      product({
        id: 4,
        prices: { price: "not a number", currency_code: "USD", currency_minor_unit: 2 },
      }),
      product({ id: 5, description: "", short_description: "" }),
      product({ id: 6, name: "   " }),
      product({
        id: 7,
        prices: { price: "500", currency_code: "us dollars", currency_minor_unit: 2 },
      }),
      product({ id: 8, virtual: false }),
      product({ id: 9, downloadable: false }),
      product({ id: 10, downloads: [] }),
      product({
        id: 11,
        downloads: [
          { id: "a", name: "A", file: "https://shop.example.com/a" },
          { id: "b", name: "B", file: "https://shop.example.com/b" },
        ],
      }),
      product({ id: 12, download_limit: 1 }),
      product({ id: 13, download_expiry: 1 }),
      product({ id: 14, manage_stock: true }),
      product({ id: 15, status: "draft" }),
    ]);

    expect(cards).toHaveLength(0);
    expect(skipped.map((one) => one.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
    ]);
    for (const one of skipped) {
      expect(one.why).toMatch(/\S/);
    }
    expect(skipped[0]?.why).toContain("variable");
  });

  it("keeps the products it can beside the ones it cannot", () => {
    const { cards, skipped } = cardsFromTheShop([
      product({ id: 10 }),
      product({ id: 11, type: "variable" }),
      product({ id: 12 }),
    ]);
    expect(cards.map((one) => one.card.merchant_item_id)).toEqual([
      expect.stringMatching(/^woo_[a-f0-9]{16}_10$/),
      expect.stringMatching(/^woo_[a-f0-9]{16}_12$/),
    ]);
    expect(skipped.map((one) => one.id)).toEqual(["11"]);
  });

  it("names each skipped product the way the merchant sees it in their shop", () => {
    const { skipped } = cardsFromTheShop([
      product({ id: 9, name: "Абонемент на месяц", type: "variable" }),
    ]);
    expect(skipped[0]?.title).toBe("Абонемент на месяц");
  });
});
