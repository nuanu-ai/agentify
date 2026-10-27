/**
 * The scale tests matter most: a Store API price is minor units with the scale
 * beside it, and a converter that ignores the scale sells a $120 product for
 * $1.20, or asks for twelve thousand.
 */

import { CardSchema } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { cardsFromTheShop, decimalOfMinorUnits, type StoreProduct } from "./woo-catalog.js";

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
    // A scale of zero is a real answer, not a missing one, so it must not
    // become "assume two".
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
    // Three minor digits is where a converter written for dollars is wrong by a
    // factor of ten, a mistake nobody notices in a list.
    expect(decimalOfMinorUnits("1234", 3)).toBe("1.234");
    expect(decimalOfMinorUnits("1234", 4)).toBe("0.1234");
  });

  it("is an amount our own contract accepts", () => {
    // Held to the contract's price rule rather than a shape written out here.
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
    // Null rather than a guess: each would otherwise become a price somebody
    // sells at.
    expect(decimalOfMinorUnits("", 2)).toBeNull();
    expect(decimalOfMinorUnits("12.00", 2)).toBeNull();
    expect(decimalOfMinorUnits("-500", 2)).toBeNull();
    expect(decimalOfMinorUnits("1e3", 2)).toBeNull();
    expect(decimalOfMinorUnits("500", -1)).toBeNull();
    expect(decimalOfMinorUnits("500", 1.5)).toBeNull();
    expect(decimalOfMinorUnits("500", 1_000_000_000)).toBeNull();
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
    // The Store API passes names through wptexturize and convert_chars; the
    // first name is the one a live shop serves.
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
    expect(
      Object.fromEntries(
        Object.entries(cards[0]?.card.result ?? {}).map(([name, field]) => [
          name,
          typeof field === "string" ? field : field.type,
        ]),
      ),
    ).toEqual({
      download_url: "string",
      file_name: "string",
      order_number: "string",
    });
    expect(cards[0]?.card.fulfillment).toBe("async");
    expect(cards[0]?.card.price_check).toBe("handler");
  });

  it("does not shorten a description the shop wrote long", () => {
    // Cutting it here would publish prose the merchant never wrote under their
    // name.
    const long = "a".repeat(900);
    const { cards } = cardsFromTheShop([product({ description: `<p>${long}</p>` })]);
    expect(cards[0]?.card.description).toBe(long);
  });

  it("names the setting for a price at another scale, and the currency for another currency", () => {
    // Retyping prices with cents does not fix a whole-dollar shop, so the
    // refusal names the one setting that changes the scale; a shop in euros is
    // not fixed by that setting, so its refusal does not name it.
    const { skipped } = cardsFromTheShop([
      product({ id: 1, prices: { price: "25", currency_code: "USD", currency_minor_unit: 0 } }),
      product({ id: 2, prices: { price: "2500", currency_code: "EUR", currency_minor_unit: 2 } }),
    ]);

    const why = Object.fromEntries(skipped.map((one) => [one.id, one.why]));
    expect(why["1"]).toContain("Number of decimals");
    expect(why["2"]).toContain("EUR");
    expect(why["2"]).not.toContain("Number of decimals");
  });

  it("prices a rupiah product in US dollars at the merchant's rate, rounded up to the cent", () => {
    const rupiah = (id: number, price: string) =>
      product({ id, prices: { price, currency_code: "IDR", currency_minor_unit: 0 } });

    const { cards, skipped } = cardsFromTheShop(
      [rupiah(1, "250000"), rupiah(2, "2000"), rupiah(3, "40500000")],
      "https://shop.example.com",
      { currency: "IDR", decimals: 0, rate: "18000" },
    );

    expect(skipped).toEqual([]);
    expect(cards.map((one) => one.card.price)).toEqual([
      { amount: "13.89", currency: "USD" },
      { amount: "0.12", currency: "USD" },
      { amount: "2250.00", currency: "USD" },
    ]);
    for (const one of cards) expect(CardSchema.safeParse(one.card).success).toBe(true);
  });

  it("leaves a product the public catalogue prices in another currency than the shop's setting", () => {
    // A currency switcher answering the catalogue by visitor is the usual
    // cause; the rate was set for the setting's currency, not the visitor's.
    const { cards, skipped } = cardsFromTheShop(
      [product({ id: 1, prices: { price: "1450", currency_code: "EUR", currency_minor_unit: 2 } })],
      "https://shop.example.com",
      { currency: "IDR", decimals: 0, rate: "18000" },
    );

    expect(cards).toEqual([]);
    expect(skipped[0]?.why).toContain("EUR");
    expect(skipped[0]?.why).toContain("IDR");
  });

  it("leaves a product priced at zero in the shop, in the door's own words", () => {
    // Nothing sells at zero, so the product is named as left in the shop with
    // the reason publishing would give; one cent is the other side of the line.
    const { cards, skipped } = cardsFromTheShop([
      product({ id: 1, prices: { price: "0", currency_code: "USD", currency_minor_unit: 2 } }),
      product({ id: 2, prices: { price: "1", currency_code: "USD", currency_minor_unit: 2 } }),
    ]);

    expect(cards.map((one) => one.id)).toEqual(["2"]);
    expect(skipped.map((one) => one.id)).toEqual(["1"]);
    expect(skipped[0]?.why).toContain("zero");
  });

  it.each<[string, Partial<StoreProduct>, RegExp, boolean]>([
    ["variable product", { type: "variable" }, /variable.*aren.t supported/i, false],
    ["not purchasable", { is_purchasable: false }, /does not offer.*sale/i, true],
    ["out of stock", { is_in_stock: false }, /out of stock/i, true],
    [
      "unreadable amount",
      { prices: { price: "not a number", currency_code: "USD", currency_minor_unit: 2 } },
      /price.*not a number.*read.*amount/i,
      true,
    ],
    ["missing description", { description: "", short_description: "" }, /no description/i, true],
    ["missing title", { name: "   " }, /no name/i, true],
    [
      "unexpected currency",
      { prices: { price: "500", currency_code: "us dollars", currency_minor_unit: 2 } },
      /catalogue.*us dollars.*currency setting.*USD/i,
      true,
    ],
    ["download also ships", { virtual: false }, /download.*also ships/i, false],
    ["virtual without download", { downloadable: false }, /virtual.*no download/i, false],
    ["missing file", { downloads: [] }, /exactly one downloadable file/i, true],
    [
      "two files",
      {
        downloads: [
          { id: "a", name: "A", file: "https://shop.example.com/a" },
          { id: "b", name: "B", file: "https://shop.example.com/b" },
        ],
      },
      /exactly one downloadable file/i,
      true,
    ],
    ["limited downloads", { download_limit: 1 }, /unlimited uses.*no expiry/i, true],
    ["expiring download", { download_expiry: 1 }, /unlimited uses.*no expiry/i, true],
    ["managed stock", { manage_stock: true }, /without stock tracking/i, false],
    ["draft product", { status: "draft" }, /not published/i, true],
  ])(
    "leaves %s in the shop with its own reason and fixability",
    (_case, overrides, reason, fixable) => {
      const { cards, skipped } = cardsFromTheShop([product(overrides)]);
      expect(cards).toEqual([]);
      expect(skipped).toEqual([
        expect.objectContaining({ id: "11", why: expect.stringMatching(reason), fixable }),
      ]);
    },
  );

  it("tells a product the shop can put right from a kind the connector does not sell", () => {
    const { skipped } = cardsFromTheShop([
      product({ id: 1, type: "variable" }),
      product({ id: 2, virtual: false }),
      product({ id: 3, downloadable: false }),
      product({ id: 4, manage_stock: true }),
      product({ id: 5, status: "draft" }),
      product({ id: 6, description: "", short_description: "" }),
      product({ id: 7, download_limit: 1 }),
      product({ id: 8, qualification_problem: "The shop rounds tax per line." }),
    ]);
    const fixable = Object.fromEntries(skipped.map((one) => [one.id, one.fixable]));

    expect(fixable).toStrictEqual({
      "1": false,
      "2": false,
      "3": false,
      "4": false,
      "5": true,
      "6": true,
      "7": true,
      "8": true,
    });
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

  it("makes a card the door accepts out of the shapes a live shop sends", () => {
    // The name and prose as WordPress sends them: numbered references,
    // paragraphs and a hand-typed name.
    const { cards, skipped } = cardsFromTheShop([
      product({
        id: 12,
        name: "Coffee &#038; Brunch Gift Card",
        description:
          "<p>Treat someone to an unhurried morning.</p>\n<p>Valid for twelve months&#8217; time at the Caf&eacute;.</p>",
      }),
    ]);

    expect(skipped).toStrictEqual([]);
    expect(cards[0]?.card.title).toBe("Coffee & Brunch Gift Card");
    expect(cards[0]?.card.description).toBe(
      "Treat someone to an unhurried morning. Valid for twelve months’ time at the Café.",
    );
    expect(CardSchema.safeParse(cards[0]?.card).success).toBe(true);
  });

  it("leaves a product whose page shows markup as text in the shop, and says what it found", () => {
    // The product is named with what was found rather than sent to be refused
    // for HTML the merchant never wrote.
    const { cards, skipped } = cardsFromTheShop([
      product({ id: 1, description: "<p>Adds a &lt;header&gt; block to the theme.</p>" }),
      product({ id: 2, name: "Coffee &amp;amp; Brunch" }),
      product({ id: 3 }),
    ]);

    expect(cards.map((one) => one.id)).toStrictEqual(["3"]);
    expect(skipped.map((one) => one.id)).toStrictEqual(["1", "2"]);
    expect(skipped[0]?.why).toContain('"<header>"');
    expect(skipped[0]?.why).toContain("description");
    expect(skipped[1]?.why).toContain('"&amp;"');
    expect(skipped[1]?.why).toContain("name");
  });

  it("names each skipped product the way the merchant sees it in their shop", () => {
    const { skipped } = cardsFromTheShop([
      product({ id: 9, name: "Абонемент на месяц", type: "variable" }),
    ]);
    expect(skipped[0]?.title).toBe("Абонемент на месяц");
  });
});

describe("a physical product, which a carrier takes to the buyer", () => {
  const parcel = (overrides: Partial<StoreProduct> = {}): StoreProduct =>
    product({ virtual: false, downloadable: false, downloads: [], ...overrides });

  it("becomes a parcel's card, priced at purchase with seven days to ship and no result", () => {
    // The card's price is the goods alone; the price check answers the whole,
    // shipping included. The seven days stand in for a time the merchant never
    // stated, and a card naming a result would be refused.
    const { cards, skipped } = cardsFromTheShop([parcel()]);

    expect(skipped).toStrictEqual([]);
    expect(cards[0]?.card).toMatchObject({
      price: { amount: "25.00", currency: "USD" },
      fulfillment: "ship",
      price_check: "handler",
      ship_within_seconds: 604_800,
    });
    expect(cards[0]?.card.result).toBeUndefined();
    expect(CardSchema.safeParse(cards[0]?.card).success).toBe(true);
  });

  it("leaves a physical product whose stock the shop counts in the shop", () => {
    const { cards, skipped } = cardsFromTheShop([parcel({ manage_stock: true })]);

    expect(cards).toHaveLength(0);
    // Stock is the merchant's to count, so the product lands under Not
    // supported, where nothing asks them to change how their shop counts it.
    expect(skipped).toMatchObject([{ fixable: false }]);
  });
});
