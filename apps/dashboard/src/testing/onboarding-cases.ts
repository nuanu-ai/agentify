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
  request: "none",
  ready: null,
  connectedBefore: false,
};

/** The accepted situation numbers are shared by the next-step proof and gallery. */
export const ONBOARDING_CASES: readonly {
  row: number;
  when: string;
  facts: NextStepFacts;
  page: string;
  reason: string | null;
  account?: string;
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
  ...([7, 8] as const).map((row) => ({
    row,
    when: row === 7 ? "Public catalogue estimate" : "Public catalogue unread",
    facts: { ...initial, platform: "woocommerce" as const },
    page: "shop",
    reason: null,
  })),
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
    row: 17,
    when: "Checked shop can ask without a wallet",
    facts: { ...initial, through: "woocommerce", shop: "connected", ready: 2 },
    page: "shop",
    reason: null,
    account: "request",
  },
  {
    row: 18,
    when: "Test shop needs its publication profile",
    facts: { ...initial, mode: "test", through: "woocommerce", shop: "connected", ready: 2 },
    page: "shop",
    reason: null,
    account: "test-profile",
  },
  {
    row: 22,
    when: "Connected code can ask without a wallet",
    facts: { ...initial, keys: 1, contact: "2026-10-30T09:00:00Z", contactAlive: true },
    page: "code-connected",
    reason: null,
    account: "request",
  },
  {
    row: 24,
    when: "Connected test code needs its publication profile",
    facts: {
      ...initial,
      mode: "test",
      keys: 1,
      contact: "2026-10-30T09:00:00Z",
      contactAlive: true,
    },
    page: "code-connected",
    reason: null,
    account: "test-profile",
  },
  {
    row: 25,
    when: "Request stays visible when code goes quiet, without a wallet",
    facts: { ...initial, keys: 1, contact: "2026-10-30T09:00:00Z", request: "pending" },
    page: "code-silent",
    reason: null,
    account: "pending",
  },
  {
    row: 26,
    when: "Request stays visible after the wallet is saved",
    facts: {
      ...initial,
      keys: 1,
      contact: "2026-10-30T09:00:00Z",
      request: "pending",
      payoutWallet: true,
    },
    page: "code-silent",
    reason: null,
    account: "pending",
  },
  {
    row: 27,
    when: "Approved connected code needs its wallet even after going quiet",
    facts: { ...initial, keys: 1, contact: "2026-10-30T09:00:00Z", liveApproved: true },
    page: "code-silent",
    reason: null,
    account: "wallet",
  },
  {
    row: 28,
    when: "Approved shop with a wallet waits for its own publication",
    facts: {
      ...initial,
      through: "woocommerce",
      shop: "connected",
      ready: 2,
      liveApproved: true,
      payoutWallet: true,
    },
    page: "shop",
    reason: null,
    account: "none",
  },
  {
    row: 29,
    when: "Approved code can publish",
    facts: {
      ...initial,
      keys: 1,
      contact: "2026-10-30T09:00:00Z",
      contactAlive: true,
      liveApproved: true,
      payoutWallet: true,
    },
    page: "code-connected",
    reason: null,
    account: "publish-code",
  },
  {
    row: 32,
    when: "Declined request stays visible when code goes quiet",
    facts: { ...initial, keys: 1, contact: "2026-10-30T09:00:00Z", request: "declined" },
    page: "code-silent",
    reason: null,
    account: "declined",
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
    account: "withdrawn",
  },
];
