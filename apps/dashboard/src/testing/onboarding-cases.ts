import type { NextStepFacts } from "../next-step.js";

const initial: NextStepFacts = {
  mode: "live",
  platform: null,
  testAcknowledged: false,
  cards: 0,
  keys: 0,
  contact: null,
  contactAlive: false,
  outOfTouch: false,
  shop: "none",
  through: "api",
  sellerName: true,
  payoutWallet: false,
  liveApproved: false,
  selling: "open",
  unread: false,
  withdrawn: false,
  walletChange: false,
  unserved: false,
};

/** The accepted situation numbers are shared by the next-step proof and gallery. */
export const ONBOARDING_CASES: readonly {
  row: number;
  when: string;
  facts: NextStepFacts;
  page: string;
  reason: string | null;
}[] = [
  { row: 1, when: "First live visit", facts: initial, page: "platform", reason: null },
  {
    row: 2,
    when: "Another platform",
    facts: { ...initial, platform: "other" },
    page: "other",
    reason: null,
  },
  {
    row: 3,
    when: "WooCommerce chosen",
    facts: { ...initial, platform: "woocommerce" },
    page: "shop",
    reason: null,
  },
  {
    row: 4,
    when: "Code chosen",
    facts: { ...initial, platform: "api" },
    page: "code",
    reason: null,
  },
  {
    row: 5,
    when: "First test visit",
    facts: { ...initial, mode: "test" },
    page: "platform",
    reason: null,
  },
  {
    row: 6,
    when: "Shop not connected",
    facts: { ...initial, platform: "woocommerce" },
    page: "shop",
    reason: null,
  },
  ...([9, 10, 11, 12, 13, 14] as const).map((row) => ({
    row,
    when: {
      9: "Waiting for keys",
      10: "No shop keys arrived",
      11: "Read-only shop keys",
      12: "Code orders hold the switch",
      13: "Shop needs a rate",
      14: "Shop connected",
    }[row],
    facts: {
      ...initial,
      platform: "woocommerce" as const,
      shop:
        row === 9
          ? ("waiting" as const)
          : row === 10
            ? ("unanswered" as const)
            : row === 11
              ? ("read-only" as const)
              : ("connected" as const),
      through: row >= 13 ? ("woocommerce" as const) : ("api" as const),
    },
    page: "shop",
    reason: null,
  })),
  {
    row: 20,
    when: "Code needs a key",
    facts: { ...initial, platform: "api" },
    page: "code",
    reason: null,
  },
  {
    row: 21,
    when: "Code has never connected",
    facts: { ...initial, platform: "api", keys: 1 },
    page: "code",
    reason: null,
  },
  {
    row: 23,
    when: "Code went silent before publishing",
    facts: { ...initial, platform: "api", keys: 1, contact: "2026-10-30T09:00:00Z" },
    page: "code-silent",
    reason: null,
  },
  {
    row: 30,
    when: "Products are on sale",
    facts: {
      ...initial,
      cards: 1,
      keys: 1,
      contact: "2026-10-30T09:00:00Z",
      contactAlive: true,
      payoutWallet: true,
      liveApproved: true,
    },
    page: "products",
    reason: null,
  },
  {
    row: 31,
    when: "Live approval withdrawn",
    facts: {
      ...initial,
      cards: 1,
      keys: 1,
      contact: "2026-10-30T09:00:00Z",
      contactAlive: true,
      payoutWallet: true,
      withdrawn: true,
    },
    page: "products",
    reason: "not_approved",
  },
];
