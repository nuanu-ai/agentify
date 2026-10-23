/**
 * Taking a merchant's listing name away, over the real HTTP surface: what an
 * agent and the merchant meet afterwards, and that the merchant's next name
 * puts the same cards back on sale. The rows the action leaves are held by the
 * operator's merchants contract; this is what the action does to selling.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness, type Served, serve } from "../../testing/harness.js";
import { takeListingName } from "./merchants-actions.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";

const aRoom: Card = {
  merchant_item_id: "a-room",
  title: "A room",
  description: "A room for one night",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

let open: { harnessed: Harness; served: Served } | null = null;

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

describe("a listing name the operator took away", () => {
  it("takes every card of the merchant off sale until they choose a new name, then sells the same card again", async () => {
    const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO });
    const served = await serve(harnessed);
    open = { harnessed, served };
    const { key, id } = harnessed.merchant;
    const published = await served.call("POST", "/v0/catalog/publish", {
      body: aRoom,
      headers: bearer(key),
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const itemId = (published.body as { id: string }).id;
    expect((await served.call("GET", `/x402/${itemId}/purchase`)).status).toBe(402);

    const taken = await takeListingName(harnessed.store, id, {
      operator: "acc_operator",
      at: harnessed.now(),
      reason: "the name impersonates another shop",
    });

    expect(taken).toStrictEqual({ kind: "done" });
    const buying = await served.call("GET", `/x402/${itemId}/purchase`);
    expect(buying.status).toBe(409);
    expect((buying.body as { error: { code: string } }).error.code).toBe("not_selling");
    const catalog = (await served.call("GET", "/x402/catalog")).body as { items: { id: string }[] };
    expect(catalog.items.map((item) => item.id)).not.toContain(itemId);
    // What the merchant reads: no name, their card still theirs and not selling.
    const named = await served.call("GET", "/v0/seller-name", { headers: bearer(key) });
    expect((named.body as { seller_name: string | null }).seller_name).toBeNull();
    const own = (await served.call("GET", "/v0/cards", { headers: bearer(key) })).body as {
      cards: { id: string; selling: string }[];
    };
    expect(own.cards.find((card) => card.id === itemId)?.selling).not.toBe("open");

    const renamed = await served.call("POST", "/v0/seller-name", {
      body: { seller_name: "Their own shop" },
      headers: bearer(key),
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect((await served.call("GET", `/x402/${itemId}/purchase`)).status).toBe(402);
  });
});
