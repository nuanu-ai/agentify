/**
 * The one rule about what a merchant must have before their cards are sold.
 *
 * The publish door, the sale-time check and the cabinet each ask it, and each
 * is tested through its own surface: the door over HTTP in the gateway, the
 * screens over HTTP in the cabinet. What is here is what only this function
 * decides, and which no single caller shows whole: the table of what each
 * surface asks for, and the difference between a fact that is absent and a
 * fact the caller could not read. The cabinet reads no approval, and a rule
 * that turned its "I don't know" into "there is none" would tell a merchant
 * they are refused for something they may hold, while one that turned it into
 * "there is one" would send them to press a button that fails.
 */

import { describe, expect, it } from "vitest";
import type { SurfaceMode } from "../deployment/environment.js";
import { type MerchantFacts, readinessOf, UNKNOWN } from "./readiness.js";

const NOTHING_SET: MerchantFacts = { sellerName: null, payoutWallet: null, liveApproval: false };
const EVERYTHING_SET: MerchantFacts = {
  sellerName: "Their own shop",
  payoutWallet: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  liveApproval: true,
};
const NOTHING_READ: MerchantFacts = {
  sellerName: UNKNOWN,
  payoutWallet: UNKNOWN,
  liveApproval: UNKNOWN,
};

const SURFACES: readonly SurfaceMode[] = ["sandbox", "test", "live"];

describe("what a surface asks of a merchant", () => {
  it("asks for a name everywhere, a wallet where a payment settles, and approval on live alone", () => {
    // The sandbox settles against nothing, so there is no money to send and no
    // address to be missing; a payment request names its seller there as
    // anywhere; and the operator admits merchants to the live catalog only.
    // The order is the order a refusal names them in.
    expect(readinessOf(NOTHING_SET, "sandbox").missing).toStrictEqual(["no_seller_name"]);
    expect(readinessOf(NOTHING_SET, "test").missing).toStrictEqual([
      "no_seller_name",
      "no_payout_wallet",
    ]);
    expect(readinessOf(NOTHING_SET, "live").missing).toStrictEqual([
      "no_seller_name",
      "no_payout_wallet",
      "no_operator_approval",
    ]);
  });

  it("says what it asks for whatever the merchant has set", () => {
    // A settings screen says whether a wallet is needed at all, and a merchant
    // who has set one must not read that it has stopped being needed.
    for (const surface of SURFACES) {
      expect(readinessOf(EVERYTHING_SET, surface).asked, surface).toStrictEqual(
        readinessOf(NOTHING_SET, surface).missing,
      );
    }
  });

  it("finds nothing missing for a merchant who has everything", () => {
    for (const surface of SURFACES) {
      expect(readinessOf(EVERYTHING_SET, surface), surface).toMatchObject({
        missing: [],
        unknown: [],
      });
    }
  });
});

describe("a fact the caller could not read", () => {
  it("is never reported as missing, and is reported as not known where it is asked for", () => {
    for (const surface of SURFACES) {
      const read = readinessOf(NOTHING_READ, surface);
      expect(read.missing, surface).toStrictEqual([]);
      expect(read.unknown, surface).toStrictEqual(read.asked);
    }
  });

  it("is not reported at all where the surface does not ask for it", () => {
    // Approval unread on the test channel is no gap: nobody approves anybody
    // there, and a page that said it could not tell would send a merchant
    // looking for something that does not exist.
    const unread = { ...EVERYTHING_SET, liveApproval: UNKNOWN };
    expect(readinessOf(unread, "test").unknown).toStrictEqual([]);
    expect(readinessOf(unread, "live").unknown).toStrictEqual(["no_operator_approval"]);
  });

  it("leaves what was read to be judged as it stands", () => {
    // The cabinet reads the name and the wallet and never the approval; what
    // it read still decides what is missing.
    const cabinet = { sellerName: null, payoutWallet: null, liveApproval: UNKNOWN };
    expect(readinessOf(cabinet, "live")).toMatchObject({
      missing: ["no_seller_name", "no_payout_wallet"],
      unknown: ["no_operator_approval"],
    });
  });
});
