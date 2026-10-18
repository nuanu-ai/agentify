/**
 * The banner over every dashboard page names each reason the account is not
 * selling as usual, from what the page read, and says nothing when nothing is
 * wrong: a banner that never leaves is one nobody reads.
 */

import { describe, expect, it } from "vitest";
import { accountOf } from "./account-banner.js";
import type { Viewer } from "./viewer.js";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** A live merchant with everything set, as the cards screen reads one. */
const READY: Viewer = {
  base: "",
  mode: "live",
  who: "owner@example.com",
  confirmed: true,
  sellerName: "Freeland",
  payout: { wallet: WALLET },
  liveApproval: true,
};

const reasonsOf = (...args: Parameters<typeof accountOf>) =>
  accountOf(...args).map((note) => note.reason);

describe("the account banner", () => {
  it("says nothing for a merchant selling as usual through their own code", () => {
    expect(accountOf(READY, { selling: "open", through: "api" })).toStrictEqual([]);
  });

  it.each([
    ["not approved for live sales", { ...READY, liveApproval: false }, {}, "not_approved"],
    ["without a seller name", { ...READY, sellerName: null }, {}, "no_seller_name"],
    ["without a payout wallet", { ...READY, payout: { wallet: null } }, {}, "no_payout_wallet"],
    ["with all sales paused", READY, { selling: "paused" }, "paused"],
    ["who has left", READY, { selling: "departed" }, "left"],
    ["selling through a WooCommerce shop", READY, { through: "woocommerce" }, "through_shop"],
  ] as const)("names a merchant %s", (_who, viewer, read, reason) => {
    const notes = accountOf(viewer, read);

    expect(notes.map((note) => note.reason)).toStrictEqual([reason]);
    expect(notes[0]?.title).toBeTruthy();
    expect(notes[0]?.says).toMatch(/\.$/);
  });

  it("names every reason that holds at once, broadest first", () => {
    const viewer: Viewer = { ...READY, sellerName: null, payout: { wallet: null } };

    expect(reasonsOf({ ...viewer, liveApproval: false }, { selling: "paused" })).toStrictEqual([
      "paused",
      "not_approved",
      "no_seller_name",
      "no_payout_wallet",
    ]);
  });

  it("says only that the merchant has left, since nothing else would put a card on sale", () => {
    const viewer: Viewer = { ...READY, sellerName: null, liveApproval: false };

    expect(reasonsOf(viewer, { selling: "departed", through: "woocommerce" })).toStrictEqual([
      "left",
    ]);
  });

  it("names nothing that rests on what the page did not read", () => {
    // The orders and receipts read the seller name and the selling state, not
    // the wallet, the approval or the integration.
    const unread: Viewer = { base: "", mode: "live", who: READY.who, confirmed: true };

    expect(accountOf(unread)).toStrictEqual([]);
    expect(reasonsOf({ ...unread, sellerName: null })).toStrictEqual(["no_seller_name"]);
  });

  it("asks for the payout wallet and the approval only where publishing asks for them", () => {
    const bare: Viewer = { ...READY, payout: { wallet: null }, liveApproval: false };

    expect(reasonsOf({ ...bare, mode: "sandbox" })).toStrictEqual([]);
    expect(reasonsOf({ ...bare, mode: "test" })).toStrictEqual(["no_payout_wallet"]);
  });

  it("points at the page that puts a setting right, and at none for the approval", () => {
    const viewer: Viewer = { ...READY, sellerName: null, liveApproval: false };

    expect(accountOf(viewer).map((note) => [note.reason, note.fix?.to ?? null])).toStrictEqual([
      ["not_approved", null],
      ["no_seller_name", "/settings"],
    ]);
  });
});
