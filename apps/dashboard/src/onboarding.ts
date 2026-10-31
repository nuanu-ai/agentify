import type { SurfaceMode } from "@agentify/core";
import type { KeysView } from "./keys.js";
import type { NextStep } from "./next-step.js";
import type { WalletEntryView } from "./settings-view.js";
import type { MomentView } from "./views.js";

export interface OnboardingView {
  readonly mode: SurfaceMode;
  readonly step: NextStep;
  readonly keys: KeysView | null;
  readonly contact: MomentView | null;
  readonly origin: string;
  readonly unread: boolean;
  readonly publicationPending?: boolean;
  readonly account?: ReturnType<typeof onboardingAccountView>;
}

export interface OnboardingPress {
  readonly screen: "onboarding";
  readonly problem: string | null;
  readonly sellerName: string;
  readonly wallet: string;
  readonly nameProblem?: string;
  readonly walletProblem?: string;
  readonly requestNeedsCheck?: true;
  readonly requestResolvedProblem?: string;
}

interface AccountFacts {
  mode: SurfaceMode;
  sellerName: string;
  savedWallet: string | null;
  nameRule: string;
  wallet: WalletEntryView | null;
  email: string;
  request: Readonly<{ at: MomentView }> | null;
  decision: Readonly<{ at: MomentView; note: string | null }> | null;
}

/** Present the saved account facts; values from a refused press stay with that press. */
export function onboardingAccountView(step: NextStep, account: Readonly<AccountFacts>) {
  const state = step.account;
  const request = state === "request" || state === "declined" || state === "withdrawn";
  const profile = state === "test-profile";
  const wallet =
    !request &&
    account.wallet !== null &&
    state !== "none" &&
    state !== "seller-name" &&
    state !== "publish-code";
  const declined = state === "declined" || state === "withdrawn";
  return {
    active: state !== "none",
    email: account.email,
    publication: {
      checking: "We'll publish the products that pass this check.",
      waiting: "Preparing your publication…",
      notification: `We'll email ${account.email} when it finishes.`,
    },
    sellerName: account.sellerName,
    savedWallet: profile ? account.savedWallet : null,
    nameRule: account.nameRule,
    wallet: account.wallet,
    heading:
      state === "publish-code" && account.mode === "live"
        ? "You're approved"
        : state === "seller-name"
          ? "Add your seller name"
          : state === "pending" && account.request !== null
            ? "Request sent"
            : state === "withdrawn"
              ? "Live sales are stopped"
              : state === "declined"
                ? `Agentify didn't approve ${account.sellerName} for live sales`
                : state === "wallet"
                  ? "You're approved. Add your payout wallet."
                  : null,
    sent:
      state === "pending" && account.request !== null
        ? {
            at: account.request.at,
            label: "Sent ",
            reply: `We usually reply within one or two working days. We'll email ${account.email} when it's decided.`,
          }
        : null,
    decision:
      declined && account.decision !== null
        ? {
            ...account.decision,
            label: state === "withdrawn" ? "Agentify stopped your live sales on " : "Decided ",
            noteLabel: "Note from Agentify:",
          }
        : null,
    paragraphs:
      state === "publish-code"
        ? ["Publish your products from your code."]
        : state === "seller-name"
          ? ["Choose the name buyers see before publishing."]
          : state === "pending" && account.request !== null && wallet
            ? [
                step.page === "shop"
                  ? "Meanwhile, add your payout wallet, so your ready products go on sale as soon as you're approved."
                  : "Meanwhile, add your payout wallet, so you can publish as soon as you're approved.",
              ]
            : declined
              ? ["Fix what the note asks, then ask again."]
              : state === "request"
                ? ["Live sales start once Agentify approves your shop."]
                : state === "wallet"
                  ? [
                      step.page === "shop"
                        ? "We publish your ready products as soon as it's saved."
                        : "Then publish your products from your code.",
                    ]
                  : [],
    link:
      state === "publish-code"
        ? {
            href: "/docs/quickstart#_4-publish-one-card",
            label: "Open the publishing guide",
            external: true,
            problem: true,
          }
        : state === "seller-name"
          ? {
              href: "/settings",
              label: "Open Settings",
              external: false,
              problem: false,
            }
          : null,
    form:
      request || profile || wallet
        ? {
            intent: request
              ? "request-live-sales"
              : profile
                ? "save-onboarding-profile"
                : "save-onboarding-wallet",
            publish: profile,
            name:
              request || profile
                ? {
                    label: "Seller name",
                    explanation:
                      "Buyers see this name next to your products and in the payment they approve.",
                  }
                : null,
            wallet: wallet
              ? {
                  label: "Wallet address",
                  noWallet: "No wallet yet?",
                  createWallet: "Create a Coinbase Wallet",
                  walletWindow:
                    "Coinbase's window opens over this page, and the new wallet's address comes into the box above for you to check and save.",
                  explanation:
                    "Paste your wallet's public address. Never enter a private key or recovery phrase.",
                }
              : null,
            submit: request
              ? state === "request"
                ? "Ask for live sales"
                : "Ask again"
              : profile
                ? wallet
                  ? "Save name and wallet"
                  : "Save name"
                : state === "wallet" && step.page === "shop"
                  ? "Save wallet and publish"
                  : "Save wallet",
          }
        : null,
  };
}
