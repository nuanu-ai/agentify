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
}

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
  readonly approvalNeeded: boolean;
  readonly profileStep: "seller-name" | "payout-wallet" | null;
}

/** A page's next action and at most one reason that belongs on every page. */
export function nextStepOf(facts: NextStepFacts): NextStep {
  const started = facts.keys > 0 || facts.contact !== null || facts.shop !== "none";
  const page: NextStep["page"] =
    facts.cards > 0
      ? "products"
      : facts.through === "woocommerce" || facts.platform === "woocommerce" || facts.shop !== "none"
        ? "shop"
        : facts.contact !== null
          ? facts.contactAlive
            ? "code-connected"
            : "code-silent"
          : facts.keys > 0 || facts.platform === "api"
            ? "code"
            : facts.platform === "other"
              ? "other"
              : "platform";
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
  return {
    page,
    reason,
    approvalNeeded: door.missing.includes("no_operator_approval"),
    profileStep: door.missing.includes("no_seller_name")
      ? "seller-name"
      : door.missing.includes("no_payout_wallet")
        ? "payout-wallet"
        : null,
    practice:
      facts.mode === "live" && page === "platform" && !started && !facts.withdrawn && !facts.unread,
    acknowledgeTest: facts.mode === "test" && !facts.testAcknowledged && !facts.unread,
  };
}
