/**
 * What the pages still drawn as strings say about the stack and the operator's
 * approval, drawn from values the contract's schemas would accept, so nothing
 * is stubbed.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/core";
import { describe, expect, it } from "vitest";
import { page } from "./html.js";
import type { Viewer } from "./screens.js";
import { settingsScreen } from "./seller-name.js";
import { readable } from "./testing/html.js";

/** Every screen says who it is drawn for. */
const SEEN_BY: Viewer = { base: "", mode: "sandbox", who: "owner@example.com", confirmed: true };

describe("what a page says about the stack it belongs to", () => {
  it("carries the same marker on a signed-in page", () => {
    // Pages behind the sign-in must carry the stack label too.
    const html = page({
      base: "",
      who: "owner@example.com",
      confirmed: true,
      tab: "cards",
      title: "Cards",
      mode: "test",
      body: "<p>x</p>",
    });

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="test"`);
    expect(readable(html)).toContain(SURFACE_WORDS.test);
  });
});

describe("whether a live merchant is approved", () => {
  // A live merchant is told whether they have the operator's approval.
  const live = (approved: boolean): Viewer => ({
    ...SEEN_BY,
    mode: "live",
    sellerName: "Freeland",
    sellerSite: "https://freeland.example",
    payout: { wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", pending: null },
    liveApproval: approved,
  });

  it("says on Settings whether Agentify has approved the merchant for live sales", () => {
    const approved = readable(settingsScreen(live(true)));
    const waiting = readable(settingsScreen(live(false)));

    expect(approved).toMatch(/approved your merchant/);
    expect(waiting).toMatch(/not approved your merchant/);
    expect(approved).not.toMatch(/not approved your merchant/);
  });

  it("says nothing about the approval off the live channel, where nobody needs it", () => {
    for (const mode of ["sandbox", "test"] as const) {
      const unapproved = { ...live(false), mode };

      expect(readable(settingsScreen(unapproved)), mode).not.toMatch(/approv/i);
    }
  });
});
