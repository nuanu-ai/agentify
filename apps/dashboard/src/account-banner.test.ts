/**
 * The banner over every dashboard page names each reason the account is not
 * selling as usual, from what the page read, and says nothing when nothing is
 * wrong: a banner that never leaves is one nobody reads.
 */

import { describe, expect, it } from "vitest";
import { accountOf } from "./account-banner.js";
import type { Viewer } from "./viewer.js";
import { headingOf } from "./words.js";

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
  it("says nothing for a merchant selling as usual", () => {
    expect(accountOf(READY, { selling: "open" })).toStrictEqual([]);
  });

  it.each([
    ["not approved for live sales", { ...READY, liveApproval: false }, {}, "not_approved"],
    ["without a seller name", { ...READY, sellerName: null }, {}, "no_seller_name"],
    ["without a payout wallet", { ...READY, payout: { wallet: null } }, {}, "no_payout_wallet"],
    ["with all sales paused", READY, { selling: "paused" }, "paused"],
  ] as const)("names a merchant %s", (_who, viewer, read, reason) => {
    const notes = accountOf(viewer, read);

    expect(notes.map((note) => note.reason)).toStrictEqual([reason]);
    expect(notes[0]?.title).toBeTruthy();
    expect(notes[0]?.says).toMatch(/\.$/);
  });

  it("says when a merchant's integration last connected while their products are off sale for it", () => {
    const [since] = accountOf(READY, {
      selling: "open",
      outOfTouch: { since: "2026-10-21T14:02:07.000Z" },
    });
    const [never] = accountOf(READY, { outOfTouch: { since: null } });

    expect(since?.reason).toBe("out_of_touch");
    expect(since?.says).toContain("2026-10-21 14:02:07 UTC");
    expect(never?.reason).toBe("out_of_touch");
    expect(never?.says).not.toBe(since?.says);
    // Nothing is paused that the merchant has to resume: the first poll lets
    // the next purchase through, so the way on is what to check, in the
    // documentation, and no switch on a page of the dashboard.
    expect([since?.fix?.to, never?.fix?.to]).toStrictEqual([
      "/docs/failures#your-integration-has-not-connected",
      "/docs/failures#your-integration-has-not-connected",
    ]);
  });

  it("names a merchant whose purchases waiting for payment fill the limit, with nothing to switch on", () => {
    const notes = accountOf(READY, { selling: "open", busy: true });

    expect(notes.map((note) => note.reason)).toStrictEqual(["busy"]);
    expect(notes[0]?.fix).toBeNull();
  });

  it("says new purchases are refused while ten paid orders are left unserved, and leads to the orders that need the merchant", () => {
    const [note] = accountOf(READY, { selling: "open", unserved: true });

    expect(note?.reason).toBe("unserved");
    expect(note?.fix?.to).toBe("/orders?show=needs");
  });

  it("heads silence and the unpaid purchases together by what silence does to every product", () => {
    const both = accountOf(READY, { selling: "open", busy: true, outOfTouch: { since: null } });
    const silent = accountOf(READY, { selling: "open", outOfTouch: { since: null } });

    expect(both.map((note) => note.reason)).toStrictEqual(["out_of_touch", "busy"]);
    expect(headingOf(both)).toBe(headingOf(silent));
  });

  it("names a waiting change of the payout wallet before every other reason, with the address, the moment it applies and the wallet paid now", () => {
    const waiting = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
    const notes = accountOf(READY, {
      selling: "paused",
      walletChange: { wallet: waiting, takesEffectAt: "2026-10-28T16:05:00.000Z" },
    });

    expect(notes.map((note) => note.reason)).toStrictEqual(["wallet_change", "paused"]);
    // What the cancel carries back, so a press that arrives after the change
    // applied is told apart from a cancel.
    expect(notes[0]?.change).toMatchObject({
      wallet: waiting,
      takesEffectAt: "2026-10-28T16:05:00.000Z",
      paid: WALLET,
    });
  });

  it("names every reason that holds at once, those the merchant puts right first", () => {
    const viewer: Viewer = { ...READY, sellerName: null, payout: { wallet: null } };

    expect(reasonsOf({ ...viewer, liveApproval: false }, { selling: "paused" })).toStrictEqual([
      "paused",
      "no_seller_name",
      "no_payout_wallet",
      "not_approved",
    ]);
  });

  it("heads one reason with its own title, and several that keep the products off sale with one heading", () => {
    const one = accountOf(READY, { selling: "paused" });
    const several = [
      accountOf({ ...READY, sellerName: null }, { selling: "paused" }),
      accountOf({ ...READY, liveApproval: false, payout: { wallet: null } }),
      accountOf({ ...READY, sellerName: null }, { unread: true }),
    ];

    expect(headingOf(one)).toBe(one[0]?.title);
    expect(new Set(several.map(headingOf)).size).toBe(1);
    expect(headingOf(several[0] ?? [])).not.toBe(headingOf(one));
  });

  it("says it could not check where a read failed, beside what the other reads found", () => {
    expect(reasonsOf({ ...READY, sellerName: null }, { unread: true })).toStrictEqual([
      "no_seller_name",
      "unread",
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

  it("says live sales are stopped, since when and with Agentify's note, while a withdrawal stands", () => {
    const withdrawn: Viewer = { ...READY, liveApproval: false };
    const note = "Your seller name copies another shop's; choose your own.";

    const [stopped] = accountOf(withdrawn, {
      withdrawn: { at: "2026-10-23T14:09:00.000Z", note },
    });

    const notYet = accountOf(withdrawn)[0];
    expect(stopped?.reason).toBe("not_approved");
    // Not the words of a merchant never admitted, nor their way to the test channel.
    expect(stopped?.title).not.toBe(notYet?.title);
    expect(stopped?.says).toContain("2026-10-23 14:09:00 UTC");
    expect(stopped?.says).toContain(`“${note}”`);
    expect(stopped?.fix).toBeNull();
    expect(notYet?.fix).not.toBeNull();
  });

  it("points at the page that puts a setting right, and from the approval to the test channel's dashboard", () => {
    const viewer: Viewer = { ...READY, sellerName: null, liveApproval: false };

    expect(accountOf(viewer).map((note) => [note.reason, note.fix?.to ?? null])).toStrictEqual([
      ["no_seller_name", "/settings"],
      ["not_approved", "https://test.agentify.ad/dashboard/sign-in"],
    ]);
  });

  it("gives a merchant not yet approved for live sales the address to ask for approval at", () => {
    const notYet = accountOf({ ...READY, liveApproval: false }).find(
      (note) => note.reason === "not_approved",
    );

    expect(notYet?.says).toContain("admin@agentify.ad");
  });
});
