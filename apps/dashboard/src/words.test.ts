/**
 * The maps are walked from the contract's own lists rather than their own keys,
 * so a value added to a vocabulary fails here until somebody writes its words.
 */

import {
  FulfillmentSchema,
  ORDER_STATUSES,
  ReceiptOutcomeSchema,
} from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import {
  dayOf,
  FULFILLMENT_WORDS,
  moment,
  money,
  needsYou,
  ORDER_WORDS,
  waitsOnTheBuyer,
} from "./words.js";

describe("the words a merchant reads", () => {
  it("has one for every state an order can be in", () => {
    for (const status of ORDER_STATUSES) {
      expect(ORDER_WORDS[status]?.text, status).toBeTruthy();
      // `refund_due` on a screen is a field name, not a sentence.
      expect(ORDER_WORDS[status]?.text, status).not.toContain("_");
    }
  });

  it("covers every outcome a receipt can carry with the order's own words", () => {
    // A receipt's outcomes are a subset of the order's, so one map serves both
    // screens and a state reads the same on each.
    for (const outcome of ReceiptOutcomeSchema.options) {
      expect(ORDER_WORDS[outcome]?.text, outcome).toBeTruthy();
    }
  });

  it("has one for every fulfillment mode", () => {
    for (const mode of FulfillmentSchema.options) {
      expect(FULFILLMENT_WORDS[mode], mode).toBeTruthy();
    }
  });

  it("holds as waiting on the buyer only goods delivered against a failed payment", () => {
    // A payment nobody heard back about is refused a repeat, so its buyer
    // cannot pay again, and it must not be listed as waiting for them to.
    const waiting = ORDER_STATUSES.filter((status) => waitsOnTheBuyer(status));

    expect(waiting).toStrictEqual(["delivered_unpaid"]);
    expect(waitsOnTheBuyer("payment_unresolved")).toBe(false);
  });

  it("counts an order as needing the merchant only while a refund is due", () => {
    // Goods delivered against a payment that failed wait on the buyer, who can
    // pay again; the merchant has nothing to do there. An order merely under
    // way may be the merchant's to deliver, but this API cannot tell it from
    // one created a second ago, so demanding attention for it would be a claim
    // beyond the evidence.
    const needing = ORDER_STATUSES.filter((status) => needsYou(status));

    expect(needing).toStrictEqual(["refund_due"]);
  });

  it("does not name a duty for an order that may be nobody's yet", () => {
    // `in_progress` also covers an unpaid request opened a second ago that
    // closes unanswered, and nothing over this API tells the two apart; a word
    // about fulfilment or delivery would show it as goods the merchant owes.
    expect(ORDER_WORDS.in_progress.text).not.toMatch(/fulfil|deliver|accept|owe/i);
    // Still something under way rather than an ending.
    expect(ORDER_WORDS.in_progress.tone).toBe("busy");
  });

  it("does not turn a payment we never heard about into a refusal", () => {
    // A purchase whose charge went unanswered may still have been charged; a
    // merchant told otherwise would reconcile it wrongly.
    expect(ORDER_WORDS.payment_unresolved.text).toMatch(/unknown/i);
    expect(ORDER_WORDS.payment_unresolved.text).not.toContain("refus");
    expect(ORDER_WORDS.payment_unresolved.tone).toBe("warn");
  });
});

describe("money and moments on a screen", () => {
  it("prints an amount exactly as it arrived", () => {
    // Money is a decimal string on the wire so nothing turns it into a float;
    // "5.00" shown as "5" is where a merchant's books would first disagree.
    expect(money({ amount: "5.00", currency: "USD" })).toBe("5.00 USD");
    expect(money({ amount: "0.000001", currency: "USDC" })).toBe("0.000001 USDC");
    expect(money({ amount: "1234.50", currency: "USD" })).toBe("1234.50 USD");
  });

  it("says which zone a moment is in", () => {
    // The reader's zone is unknown to the server, and receipts are reconciled
    // against a wallet: two payments seconds apart must not look like one line
    // twice.
    expect(moment("2026-08-27T09:12:04Z")).toBe("2026-08-27 09:12:04 UTC");
    expect(moment("2026-08-27T11:12:04+02:00")).toBe("2026-08-27 09:12:04 UTC");
  });

  it("shows a moment it cannot read rather than inventing one", () => {
    expect(moment("not a moment")).toBe("not a moment");
    expect(dayOf("not a moment")).toBe("not a moment");
  });

  it("names the day a moment falls on in UTC, as the moments under it are given", () => {
    expect(dayOf("2026-10-12T16:40:00Z")).toBe("12 October 2026");
    // Late evening west of Greenwich is already the next day in UTC.
    expect(dayOf("2026-10-12T23:30:00-02:00")).toBe("13 October 2026");
  });
});
