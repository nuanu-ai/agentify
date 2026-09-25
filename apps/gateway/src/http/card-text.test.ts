/**
 * A card's own words at the publish door, over HTTP.
 *
 * The door refuses a title, a description or a field's title that is not plain
 * text, says what it found in the findings a merchant reads, and stores
 * nothing — it never cleans the text and publishes the result, because the
 * merchant would never learn and an agent would read words nobody wrote.
 *
 * The rule is the door's alone. A card stored before it keeps being served,
 * in the catalog and in its merchant's own list: every answer on those routes
 * is held to its contract on the way out, so a rule applied on reading would
 * turn one old row into a failed catalog for everybody.
 */

import type { Card, CatalogPage, MerchantCardList } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness, type Served, serve, theMerchantKey } from "../testing/harness.js";

const asMerchant = { authorization: `Bearer ${theMerchantKey("test")}` };

const card: Card = {
  merchant_item_id: "coffee-brunch",
  title: "Coffee and brunch for two",
  description: "A gift card for coffee, pastries or brunch from the seasonal menu.",
  price: { amount: "25.00", currency: "USD" },
  result: { code: { type: "string", title: "The code to show at the counter" } },
  fulfillment: "sync",
};

let open: { harnessed: Harness; served: Served } | null = null;

const started = async () => {
  const harnessed = await harness();
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

interface Refused {
  readonly error: { readonly code: string; readonly problems: readonly Finding[] };
}

interface Finding {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

const findingAt = (body: unknown, path: string): string | undefined =>
  (body as Refused).error.problems.find((finding) => finding.path.join(".") === path)?.message;

describe("a card's own words at the publish door", () => {
  it("refuses words that are not plain text, names what it found, and stores nothing", async () => {
    const { served } = await started();

    const answered = await served.call("POST", "/v0/catalog/publish", {
      body: {
        ...card,
        title: "Coffee &amp; Brunch",
        description: "<p>A gift card for coffee.</p>",
        result: { code: { type: "string", title: "The code\u0007" } },
      },
      headers: asMerchant,
    });

    expect(answered.status).toBe(422);
    expect((answered.body as Refused).error.code).toBe("card_rejected");
    expect(findingAt(answered.body, "title")).toContain('"&amp;"');
    expect(findingAt(answered.body, "description")).toContain('"<p>"');
    expect(findingAt(answered.body, "result.code.title")).toContain("U+0007");

    // Refused means refused: not cleaned and published anyway.
    const mine = await served.call("GET", "/v0/cards", { headers: asMerchant });
    expect((mine.body as MerchantCardList).cards).toStrictEqual([]);
  });

  it("publishes an ampersand and a comparison as written, and shows an agent the same", async () => {
    const { served } = await started();
    const words = { title: "Tea & coffee", description: "For 2 < 3 people & a dog -> brunch" };

    const answered = await served.call("POST", "/v0/catalog/publish", {
      body: { ...card, ...words },
      headers: asMerchant,
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);

    const listed = await served.call("GET", "/x402/catalog");
    expect(listed.status).toBe(200);
    expect((listed.body as CatalogPage).items[0]).toMatchObject(words);
  });

  it("keeps serving a card stored before the rule, to agents and to its merchant", async () => {
    const { served, harnessed } = await started();
    const before: Card = {
      ...card,
      title: "Coffee &#038; Brunch Gift Card",
      description: "<p>Treat someone to an unhurried morning.</p>\n<!-- wp:paragraph -->",
      result: { code: { type: "string", title: "The code&nbsp;to show" } },
    };
    await harnessed.store.publishCard(harnessed.merchant.id, before, harnessed.now());

    const listed = await served.call("GET", "/x402/catalog");
    const mine = await served.call("GET", "/v0/cards", { headers: asMerchant });

    expect(listed.status).toBe(200);
    expect((listed.body as CatalogPage).items[0]?.title).toBe(before.title);
    expect(mine.status).toBe(200);
    expect((mine.body as MerchantCardList).cards[0]?.card).toStrictEqual(before);
  });
});
