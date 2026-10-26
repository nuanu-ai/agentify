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

  it("says since when a merchant's integration has not connected while purchases paid before delivery are refused for it", () => {
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
    // the next purchase through, so the banner offers no switch.
    expect([since?.fix, never?.fix]).toStrictEqual([null, null]);
  });

  it("names how many purchases wait for payment while new ones are refused for them, and offers nothing to press", () => {
    const [note] = accountOf(READY, { selling: "open", busy: true });

    expect(note?.reason).toBe("busy");
    expect(note?.says).toContain("20");
    expect(note?.fix).toBeNull();
    // How long the places stay taken depends on how long a price holds, which
    // the dashboard does not read, and on whoever holds them; no time is promised.
    expect(note?.says).not.toMatch(/minute|second|hour/);
  });

  it("heads purchases refused for both silence and the unpaid ones by the refusal that covers every product", () => {
    const both = accountOf(READY, { selling: "open", busy: true, outOfTouch: { since: null } });
    const busy = accountOf(READY, { selling: "open", busy: true });

    expect(both.map((note) => note.reason)).toStrictEqual(["out_of_touch", "busy"]);
    expect(headingOf(both)).toBe(headingOf(busy));
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
});
