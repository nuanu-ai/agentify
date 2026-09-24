import { describe, expect, it } from "vitest";
import { addCardByHand, cardFromForm, problemsFor, typedFrom } from "./manual-card.js";

const filled = {
  title: "Monthly access",
  description: "Access to the service for thirty days.",
  merchant_item_id: "access-monthly",
  price_amount: "5.00",
  price_currency: "usd",
  result: "access_url, expires_at",
  params: "",
  tags: "access, monthly",
  fulfillment: "async",
  fulfill_hours: "4",
};

describe("a product added by hand", () => {
  it("becomes a card the contract accepts", () => {
    const read = cardFromForm(typedFrom(filled));
    expect(read).toEqual({
      card: {
        merchant_item_id: "access-monthly",
        title: "Monthly access",
        description: "Access to the service for thirty days.",
        price: { amount: "5.00", currency: "USD" },
        result: { access_url: "string", expires_at: "string" },
        tags: ["access", "monthly"],
        fulfillment: "async",
        fulfill_deadline_seconds: 14_400,
      },
    });
  });

  it("names each wrong box once, in the order of the form", () => {
    const read = cardFromForm(
      typedFrom({ ...filled, title: "", price_amount: "5,00", result: "" }),
    );
    expect(read).toEqual({
      problems: [
        "Enter a product name.",
        'Write the price as a number with a dot, such as "5.00", and the currency in capitals, such as "USD".',
        "Enter at least one field the buyer receives, in Latin letters, separated by commas, such as access_url.",
      ],
    });
  });

  it("drops the hours left in the box when the product is delivered at once", () => {
    const read = cardFromForm(typedFrom({ ...filled, fulfillment: "sync" }));
    expect("card" in read ? read.card.fulfill_deadline_seconds : "refused").toBeUndefined();
  });

  it("passes on a refusal about no box of the form in its own words", () => {
    expect(problemsFor([{ path: [], message: "choose the seller name first" }])).toEqual([
      "choose the seller name first",
    ]);
  });
});

describe("where the hand-made product form exists", () => {
  // Nothing can deliver a hand-made card yet, so a merchant on test or live
  // must never reach a form whose card no one fulfils.
  it("is a preview on the laptop stack and absent on test and live", () => {
    expect(addCardByHand("sandbox")).toBe(true);
    expect(addCardByHand("test")).toBe(false);
    expect(addCardByHand("live")).toBe(false);
  });
});
