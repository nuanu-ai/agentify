import { readinessOf, type SurfaceMode } from "@agentify/core";
import type { AccountReason } from "./words.js";

export type Platform = "woocommerce" | "api" | "other";

export interface OnboardingChoices {
  readonly platform: Platform | null;
  readonly testAcknowledged: boolean;
}

export interface NextStepFacts extends OnboardingChoices {
  readonly mode: SurfaceMode;
  readonly cards: number;
  readonly keys: number;
  readonly contact: string | null;
  readonly contactAlive: boolean;
  readonly outOfTouch: boolean;
  readonly shop: "none" | "waiting" | "unanswered" | "read-only" | "connected";
  readonly through: "api" | "woocommerce";
  readonly sellerName: boolean;
  readonly payoutWallet: boolean;
  readonly liveApproved: boolean;
  readonly selling: "open" | "paused";
  readonly unread: boolean;
  readonly withdrawn: boolean;
  readonly walletChange: boolean;
  readonly unserved: boolean;
  readonly request: "none" | "pending" | "declined";
  readonly ready: number | null;
  readonly connectedBefore: boolean;
}

type AccountStep =
  | "none"
  | "request"
  | "pending"
  | "declined"
  | "withdrawn"
  | "test-profile"
  | "seller-name"
  | "wallet"
  | "publish-code";

export interface NextStep {
  readonly page:
    | "platform"
    | "other"
    | "shop"
    | "code"
    | "code-connected"
    | "code-silent"
    | "products";
  readonly reason: AccountReason | null;
  readonly practice: boolean;
  readonly acknowledgeTest: boolean;
  readonly account: AccountStep;
  /** Whether a request for live sales sent now would be taken. */
  readonly canAsk: boolean;
  /**
   * What a request for live sales waits for while it would not be taken: code
   * that answers, a shop connection, write access to the shop, or a check that
   * finds a product ready.
   */
  readonly askWaitsFor: "code" | "shop" | "access" | "check" | null;
  readonly otherWays: boolean;
}

/** A page's next action and at most one reason that belongs on every page. */
export function nextStepOf(facts: NextStepFacts): NextStep {
  const started =
    facts.keys > 0 ||
    facts.contact !== null ||
    facts.shop === "connected" ||
    facts.shop === "read-only" ||
    facts.connectedBefore;
  let page: NextStep["page"];
  if (facts.cards > 0) page = "products";
  else if (facts.through === "woocommerce") page = "shop";
  else if (facts.contact !== null) page = facts.contactAlive ? "code-connected" : "code-silent";
  else if (facts.keys > 0) page = "code";
  else if (facts.shop === "connected" || facts.shop === "read-only") page = "shop";
  else if (facts.shop === "waiting" || facts.shop === "unanswered")
    page = facts.platform === "api" ? "code" : facts.platform === "other" ? "other" : "shop";
  else if (facts.connectedBefore) page = "code";
  else if (facts.platform === "woocommerce") page = "shop";
  else if (facts.platform === "api") page = "code";
  else if (facts.platform === "other") page = "other";
  else page = "platform";
  const door = readinessOf(
    {
      sellerName: facts.sellerName ? "set" : null,
      payoutWallet: facts.payoutWallet ? "set" : null,
      liveApproval: facts.liveApproved,
    },
    facts.mode,
  );
  const reason: AccountReason | null = facts.unread
    ? "unread"
    : facts.withdrawn
      ? "not_approved"
      : facts.walletChange
        ? "wallet_change"
        : facts.cards === 0
          ? null
          : facts.selling === "paused"
            ? "paused"
            : door.missing.includes("no_seller_name")
              ? "no_seller_name"
              : door.missing.includes("no_payout_wallet")
                ? "no_payout_wallet"
                : door.missing.includes("no_operator_approval")
                  ? "not_approved"
                  : facts.outOfTouch
                    ? "out_of_touch"
                    : facts.unserved
                      ? "unserved"
                      : null;
  const connected =
    facts.through === "woocommerce"
      ? facts.shop === "connected" && facts.ready !== null && facts.ready > 0
      : facts.contact !== null && facts.contactAlive;
  const account: AccountStep = facts.unread
    ? "none"
    : facts.mode === "live"
      ? facts.liveApproved
        ? !facts.sellerName
          ? "seller-name"
          : !facts.payoutWallet
            ? "wallet"
            : facts.through === "api" && facts.cards === 0 && facts.contact !== null
              ? "publish-code"
              : "none"
        : facts.request === "pending"
          ? "pending"
          : facts.request === "declined" || facts.withdrawn
            ? // A code page shows the key and its guide only when no decision stands over it.
              !connected && page === "code"
              ? "none"
              : facts.request === "declined"
                ? "declined"
                : "withdrawn"
            : connected
              ? "request"
              : "none"
      : connected && facts.cards === 0
        ? door.missing.includes("no_seller_name") || door.missing.includes("no_payout_wallet")
          ? "test-profile"
          : facts.through === "api"
            ? "publish-code"
            : "none"
        : "none";
  return {
    page,
    reason,
    account,
    canAsk:
      connected && (account === "request" || account === "declined" || account === "withdrawn"),
    askWaitsFor: connected
      ? null
      : facts.through === "api"
        ? "code"
        : facts.shop === "read-only"
          ? "access"
          : facts.shop === "connected"
            ? "check"
            : "shop",
    otherWays: !started && facts.request === "none" && !facts.liveApproved,
    practice:
      facts.mode === "live" &&
      page === "platform" &&
      !started &&
      !facts.liveApproved &&
      !facts.withdrawn &&
      !facts.unread,
    acknowledgeTest: facts.mode === "test" && !facts.testAcknowledged && !facts.unread,
  };
}
