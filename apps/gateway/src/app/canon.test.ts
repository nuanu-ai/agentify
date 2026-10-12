import { CatalogPageSchema, cardsOf, PublishResultSchema } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.js";

// The contracts schema opens a short spelling out into the canonical card at
// parse. This file holds the half no schema can: the gateway stores, and shows
// an agent, the canonical card rather than the raw input it was sent.

let open: Harness | null = null;
afterEach(async () => {
  await open?.stop();
  open = null;
});

const SHORT = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: "80.00 USD",
  result: { access_code: "string" },
};

const publishedShort = async (harnessed: Harness): Promise<string> => {
  const result = await harnessed.gateway.publishCard(harnessed.merchant.id, SHORT);
  expect(PublishResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok) throw new Error(`publishing failed: ${JSON.stringify(result.error.problems)}`);
  return result.id;
};

describe("the canon behind the door", () => {
  it("stores the card the door opened out, not the spelling that arrived", async () => {
    open = await harness();
    const itemId = await publishedShort(open);

    const stored = await open.store.cardById(itemId);

    expect(stored?.card.price).toStrictEqual({ amount: "80.00", currency: "USD" });
    expect(stored?.card.result).toStrictEqual({ access_code: { type: "string" } });
    expect(stored?.card.fulfillment).toBe("sync");
  });

  it("shows an agent the canon, whatever spelling the merchant wrote", async () => {
    open = await harness();
    await publishedShort(open);

    const page = CatalogPageSchema.parse(await open.gateway.catalog());

    expect(cardsOf(page)[0]?.price).toStrictEqual({ amount: "80.00", currency: "USD" });
    expect(JSON.stringify(page)).not.toContain("80.00 USD");
  });
});
