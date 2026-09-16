/**
 * The converter between a WooCommerce shop's own catalogue and our cards.
 *
 * The scale test is the one that matters most and it is why this file exists
 * before the screens do. A Store API price is a string of minor units with the
 * scale beside it — `"12000"` at `currency_minor_unit: 2` is a hundred and
 * twenty dollars — and a converter that reads the number without the scale is
 * wrong by a factor of a hundred, quietly, on every ordinary currency
 * (`docs/research/27-woo-connect-probe.md`). Wrong in the direction that sells
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
  sku: "coinslot-tote",
  type: "simple",
  description: "<p>A physical item that has to be shipped somewhere.</p>\n",
  short_description: "<p>Physical goods, shipped.</p>\n",
  is_purchasable: true,
  is_in_stock: true,
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

  it("names the card by the shop's own identifier for the product", () => {
    // The merchant's own key is the shop's product id, which is what makes a
    // second import an edit of the same card rather than a second one.
    const { cards } = cardsFromTheShop([product({ id: 42 })]);
    expect(cards[0]?.card.merchant_item_id).toBe("42");
  });

  it("takes the title and the description off the product", () => {
    const { cards } = cardsFromTheShop([product()]);
    expect(cards[0]?.card.title).toBe("Canvas tote bag");
    expect(cards[0]?.card.description).toBe("A physical item that has to be shipped somewhere.");
  });

  it("falls back to the short description where there is no other", () => {
    const { cards } = cardsFromTheShop([product({ description: "" })]);
    expect(cards[0]?.card.description).toBe("Physical goods, shipped.");
  });

  it("declares what the agent is handed, which is the order in the shop", () => {
    const { cards } = cardsFromTheShop([product()]);
    expect(cards[0]?.card.result).toHaveProperty("order_number");
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
    ]);

    expect(cards).toHaveLength(0);
    expect(skipped.map((one) => one.id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
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
    expect(cards.map((one) => one.card.merchant_item_id)).toEqual(["10", "12"]);
    expect(skipped.map((one) => one.id)).toEqual(["11"]);
  });

  it("names each skipped product the way the merchant sees it in their shop", () => {
    const { skipped } = cardsFromTheShop([
      product({ id: 9, name: "Абонемент на месяц", type: "variable" }),
    ]);
    expect(skipped[0]?.title).toBe("Абонемент на месяц");
  });
});
