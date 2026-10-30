import { describe, expect, it } from "vitest";
import { nextStepOf } from "./next-step.js";
import { ONBOARDING_CASES } from "./testing/onboarding-cases.js";

const first = ONBOARDING_CASES[0]?.facts;
if (first === undefined) throw new Error("the shared situations have no first visit");

describe("the seller's next step", () => {
  it.each(ONBOARDING_CASES)("situation $row: $when", ({ facts, page, reason }) => {
    const step = nextStepOf(facts);
    expect(step.page).toBe(page);
    expect(step.reason).toBe(reason);
    expect(step.practice).toBe(
      facts.mode === "live" && page === "platform" && !facts.withdrawn && !facts.unread,
    );
    expect(step.acknowledgeTest).toBe(facts.mode === "test" && !facts.testAcknowledged);
  });

  it("keeps account requirements quiet until there are products to sell", () => {
    expect(nextStepOf({ ...first, sellerName: false }).reason).toBeNull();
    expect(nextStepOf({ ...first, cards: 2, sellerName: false }).reason).toBe("no_seller_name");
    expect(nextStepOf({ ...first, cards: 2 }).reason).toBe("no_payout_wallet");
  });

  it("shows only the first actionable blocker and never proposes test practice after work starts", () => {
    const step = nextStepOf({ ...first, cards: 1, selling: "paused", sellerName: false });
    expect(step.reason).toBe("paused");
    expect(step.practice).toBe(false);
    expect(nextStepOf({ ...first, keys: 1 }).practice).toBe(false);
    expect(nextStepOf({ ...first, shop: "connected", through: "woocommerce" }).practice).toBe(
      false,
    );
  });

  it("distinguishes a failed account read from an unstarted account", () => {
    expect(nextStepOf({ ...first, unread: true }).reason).toBe("unread");
  });

  it("does not repeat the test acknowledgement on another visit", () => {
    expect(nextStepOf({ ...first, mode: "test", testAcknowledged: true }).acknowledgeTest).toBe(
      false,
    );
  });

  it("does not ask established integrations to answer the platform question", () => {
    expect(nextStepOf({ ...first, keys: 1 }).page).toBe("code");
    expect(nextStepOf({ ...first, shop: "connected", through: "woocommerce" }).page).toBe("shop");
    expect(
      nextStepOf({ ...first, keys: 1, contact: "2026-10-30T09:00:00Z", contactAlive: true }).page,
    ).toBe("code-connected");
  });
});

it("uses the sale door's silence fact so stale contact cannot hide unserved orders behind individually paused products", () => {
  const pausedProducts = {
    ...first,
    cards: 2,
    contactAlive: false,
    outOfTouch: false,
    payoutWallet: true,
    liveApproved: true,
    unserved: true,
  };
  expect(nextStepOf(pausedProducts).reason).toBe("unserved");
  expect(nextStepOf({ ...pausedProducts, unserved: false }).reason).toBeNull();
  expect(nextStepOf({ ...pausedProducts, outOfTouch: true }).reason).toBe("out_of_touch");
});
