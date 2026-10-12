/**
 * The fold from a merchant's and a card's state to the one word the order
 * machine is given. Which merchant facts a deployment asks for is the core's
 * `readinessOf`, tested there, and every combination a merchant can reach is
 * bought against over HTTP, where a wrong fold dies. What is left here is what
 * no route can reach: nothing sets a merchant to `departed` yet, so a defect in
 * that branch would stay green until departure is wired up, and a merchant who
 * had left would then go on selling.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import type { StoredCard } from "../ports/store.js";
import { sellingFor } from "./runtime.js";

const card: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

const stored = (paused: boolean): StoredCard => ({
  id: "itm_1",
  merchantId: "mch_1",
  card,
  asOf: 0,
  paused,
  integration: "api",
});

describe("what the order machine is told about one card", () => {
  it("keeps a merchant who left apart from one who is merely paused", () => {
    // Leaving is not a heavier pause: a pause lets accepted orders play out,
    // while leaving closes them and leaves the merchant owing refunds. Read as
    // paused, a departure would tell everything downstream that resume undoes
    // it, which it cannot.
    expect(sellingFor("departed", stored(false), true, "api")).toBe("departed");
    expect(sellingFor("departed", stored(true), true, "api")).toBe("departed");
    // And a merchant who left with no address to be paid at has still left:
    // read as paused, their open orders would look like something a resume
    // could bring back.
    expect(sellingFor("departed", stored(false), false, "api")).toBe("departed");
  });
});
