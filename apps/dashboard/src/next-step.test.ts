import { describe, expect, it } from "vitest";
import { nextStepOf } from "./next-step.js";
import { onboardingAccountView } from "./onboarding.js";
import { ONBOARDING_CASES } from "./testing/onboarding-cases.js";
import { momentView } from "./views.js";

const first = ONBOARDING_CASES[0]?.facts;
if (first === undefined) throw new Error("the shared situations have no first visit");

describe("the seller's next step", () => {
  it.each(ONBOARDING_CASES)("situation $row: $when", ({ facts, page, reason, account }) => {
    const step = nextStepOf(facts);
    expect(step.page).toBe(page);
    expect(step.reason).toBe(reason);
    if (account !== undefined) expect(step.account).toBe(account);
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

  it("follows the code that is in use instead of an old WooCommerce answer", () => {
    expect(nextStepOf({ ...first, platform: "woocommerce", keys: 1 }).page).toBe("code");
    expect(
      nextStepOf({
        ...first,
        platform: "woocommerce",
        contact: "2026-10-30T09:00:00Z",
        contactAlive: true,
      }).page,
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

it("keeps another way available before shop keys arrive, while a real connection wins over a saved answer", () => {
  const fresh = ONBOARDING_CASES[0];
  if (!fresh) throw new Error("missing initial situation");
  const waiting = { ...fresh.facts, platform: "woocommerce" as const, shop: "waiting" as const };
  expect(nextStepOf(waiting).otherWays).toBe(true);
  expect(nextStepOf({ ...waiting, platform: "api" }).page).toBe("code");
  expect(nextStepOf({ ...waiting, keys: 1 }).page).toBe("code");
  expect(nextStepOf({ ...waiting, platform: "api", shop: "connected" }).page).toBe("shop");
  expect(nextStepOf({ ...waiting, platform: "api", connectedBefore: true }).otherWays).toBe(false);
});

it.each(["waiting", "unanswered"] as const)(
  "keeps an implicit %s WooCommerce attempt without overriding an explicit other choice",
  (shop) => {
    expect(nextStepOf({ ...first, shop, platform: null }).page).toBe("shop");
    expect(nextStepOf({ ...first, shop, platform: "api" }).page).toBe("code");
    expect(nextStepOf({ ...first, shop, platform: "other" }).page).toBe("other");
    expect(nextStepOf({ ...first, shop, platform: "other", connectedBefore: true }).page).toBe(
      "other",
    );
    expect(nextStepOf({ ...first, shop, platform: null, keys: 1 }).page).toBe("code");
  },
);
it("follows code after leaving a shop even when the old platform answer still names WooCommerce", () => {
  expect(
    nextStepOf({ ...first, through: "api", connectedBefore: true, platform: "woocommerce" }).page,
  ).toBe("code");
});

it.each(
  (["connected", "read-only"] as const).flatMap((shop) => [
    { shop, keys: 1, contact: null, contactAlive: false, page: "code" },
    { shop, keys: 0, contact: "2026-10-30T09:00:00Z", contactAlive: true, page: "code-connected" },
    { shop, keys: 0, contact: "2026-10-30T09:00:00Z", contactAlive: false, page: "code-silent" },
  ]),
)(
  "keeps current API $page ahead of an inactive $shop shop and old WooCommerce answer",
  ({ page, ...current }) => {
    expect(nextStepOf({ ...first, ...current, through: "api", platform: "woocommerce" }).page).toBe(
      page,
    );
  },
);
it("keeps active WooCommerce ahead of an old API key or contact", () => {
  expect(
    nextStepOf({
      ...first,
      through: "woocommerce",
      shop: "none",
      platform: "api",
      keys: 2,
      contact: "2026-10-30T09:00:00Z",
      contactAlive: true,
    }).page,
  ).toBe("shop");
});

describe("asking again after a decline or a withdrawal", () => {
  const declined = ONBOARDING_CASES.find((one) => one.row === 32)?.facts;
  if (declined === undefined) throw new Error("the shared situations have no declined request");
  const askAgain = (facts: typeof declined) =>
    onboardingAccountView(nextStepOf(facts), {
      mode: facts.mode,
      sellerName: "Freeland",
      savedWallet: null,
      nameRule: "",
      wallet: null,
      email: "owner@shop.example",
      request: null,
      decision: {
        at: momentView("2026-10-31T09:40:00Z"),
        note: "Use the name buyers know.",
      },
    }).form?.submit;

  it.each([
    ["quiet code", declined, undefined],
    ["connected code", { ...declined, contactAlive: true }, "Ask again"],
    [
      "a shop with nothing ready",
      { ...declined, keys: 0, contact: null, through: "woocommerce", shop: "connected", ready: 0 },
      undefined,
    ],
    [
      "a shop with a ready product",
      { ...declined, keys: 0, contact: null, through: "woocommerce", shop: "connected", ready: 2 },
      "Ask again",
    ],
    ["withdrawn, quiet code", { ...declined, request: "none", withdrawn: true }, undefined],
  ] as const)("offers Ask again only when asking can succeed: %s", (_, facts, submit) => {
    expect(askAgain(facts)).toBe(submit);
  });

  it("shows the key and its guide, not the decision alone, to code that never connected", () => {
    const step = nextStepOf({ ...declined, contact: null, request: "none", withdrawn: true });
    expect(step.page).toBe("code");
    expect(step.account).toBe("none");
  });
});
