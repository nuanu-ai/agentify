/**
 * The notice of a new exchange rate is how an owner learns that a session
 * which is not theirs priced every card of the shop. Every session of the
 * account is signed in as the account's own address, so the notice tells
 * sessions apart only by what it knows of the one that saved the rate.
 */

import { describe, expect, it } from "vitest";
import { SIGN_OUT_EVERY_OTHER_DEVICE, STOP_ALL_SELLING } from "./control-labels.js";
import { type RateNotice, rateNoticeMessage } from "./woo-rate-mail.js";

const OWNER = "owner@example.com";
const SCREEN = "https://dashboard.example.com/woocommerce";

const notice = (sessionSignedInAt: Date | null): RateNotice => ({
  to: OWNER,
  shopOrigin: "https://shop.example.com",
  currency: "IDR",
  rate: "180000",
  previous: "18000",
  setAt: new Date("2026-10-22T09:30:00.000Z"),
  sessionSignedInAt,
  screen: SCREEN,
});

describe("the notice of a new exchange rate", () => {
  it("says when the session that entered the rate signed in", () => {
    const sent = rateNoticeMessage(notice(new Date("2026-10-20T08:00:00.000Z")));

    expect(sent.body).toContain("signed in to this account at 2026-10-20 08:00:00 UTC");
    expect(sent.html).toContain("2026-10-20 08:00:00 UTC");
  });

  it("does not name the account's own address as if it told who entered the rate", () => {
    for (const signedInAt of [new Date("2026-10-20T08:00:00.000Z"), null]) {
      const sent = rateNoticeMessage(notice(signedInAt));

      expect(sent.to).toBe(OWNER);
      expect(sent.body).not.toContain(OWNER);
      expect(sent.html).not.toContain(OWNER);
    }
  });

  it("says only that a session of this account entered it where that session's sign-in is not known", () => {
    const sent = rateNoticeMessage(notice(null));

    expect(sent.body).toContain("from a session signed in to this account");
    expect(sent.body).not.toMatch(/signed in (to this account )?at/);
  });

  it("keeps the previous rate, the steps to take, and a link that signs nobody in", () => {
    const sent = rateNoticeMessage(notice(new Date("2026-10-20T08:00:00.000Z")));

    expect(sent.body).toContain("The previous rate was 18000 IDR per US dollar");
    expect(sent.body).toContain(STOP_ALL_SELLING);
    expect(sent.body).toContain(SIGN_OUT_EVERY_OTHER_DEVICE);
    expect(sent.body).toContain("set your own rate again");
    expect(sent.html).toContain(`href="${SCREEN}"`);
    expect(sent.body).not.toMatch(/token=/);
  });
});
