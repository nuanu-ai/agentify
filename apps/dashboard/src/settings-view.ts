/**
 * What the settings screen shows: the name buyers read with the shop's site,
 * the payout wallet with the payout split buyers pay into and the transaction
 * that pays it out, and the account, built from one read of the gateway and
 * from what a press on the page just did.
 */

import { readinessOf, type SurfaceMode, UNKNOWN } from "@agentify/core";
import type { RecordedPayoutSplit } from "@agentify/gateway";
import { MERCHANT_FINDINGS, type PayoutWallet } from "@nuanu-ai/agentify-contracts";
import { SIGN_OUT_EVERYWHERE } from "./control-labels.js";
import type { PayoutSplits } from "./gateway.js";
import { CHANGE_ON_ITS_WAY, LIVE_CHANGE_WAITS, WALLET_RULE } from "./payout-wallet.js";
import { NAME_CANNOT_BE_TAKEN_AWAY, NAME_RULE, SITE_RULE } from "./seller-name.js";
import { type CommissionRate, percentagesOf } from "./shares.js";
import { type MomentView, momentView } from "./views.js";
import { APPROVAL_GIVEN } from "./words.js";

/**
 * What the page is drawn from: the gateway's answers, all read together,
 * where this deployment's chain shows an address, and the account's own
 * choice about product analytics.
 */
export interface Settings {
  readonly sellerName: string | null;
  readonly sellerSite: string | null;
  readonly payoutWallet: PayoutWallet;
  readonly payoutSplits: PayoutSplits;
  /** The dashboard configuration's; null where there is none, as in the sandbox. */
  readonly addressPage: string | null;
  /** The dashboard configuration's: the chain a merchant's wallet works on, null in the sandbox. */
  readonly walletChain: number | null;
  /** Read on the live channel only. */
  readonly liveApproval?: boolean;
  readonly analyticsOptedOut: boolean;
}

/**
 * A payout split shown whole beside the wallet it pays. What it pays is said
 * once, in the paragraph that names the commission.
 */
export interface SplitView {
  readonly address: string;
  /** Where the chain shows what it holds; null where there is no such page. */
  readonly explorer: string | null;
}

/**
 * The one transaction that pays out every split that can hold the merchant's
 * money, as a wallet asks for it, or why there is none to send.
 */
export type PayoutView =
  | Readonly<{
      kind: "send";
      /** Where the money waits, and on which one chain, from what, it is sent. */
      lead: string;
      to: string;
      data: string;
      /** Each split it pays out, beside the wallet written into it. */
      pays: readonly Readonly<{ split: string; wallet: string }>[];
      /** What sending it can and cannot do, and when the merchant is paid without it. */
      after: string;
      /** The chain a Coinbase Wallet sends it on, the one `lead` names; null where there is none. */
      chain: number | null;
    }>
  | Readonly<{ kind: "too_many" | "unbuilt"; said: string }>;

/** What a press did, where it answers with the page rather than sending the browser on. */
export type SettingsPress =
  | Readonly<{ kind: "name" | "site" | "wallet"; problem: string; typed: string }>
  | Readonly<{ kind: "wallet-notice"; notice: string }>;

export interface WalletView {
  readonly purpose: string;
  /** The rate, how it is taken, and that saving a wallet agrees to it. */
  readonly commission: string;
  /** As the gateway answered it, in the spelling a wallet shows; null where none is set. */
  readonly saved: string | null;
  /** The split buyers pay into, where one is recorded for the saved wallet. */
  readonly split: SplitView | null;
  readonly pending: null | Readonly<{
    wallet: string;
    takesEffectAt: string;
    from: MomentView;
    split: SplitView | null;
  }>;
  /** Why a press was not what it looked like: a cancel after the change took effect. */
  readonly notice: string | null;
  readonly rule: string;
  /** Where a different address waits before it takes effect, which is live alone. */
  readonly waits: string | null;
  /** Said while a change is on its way, where telling every account makes it slow. */
  readonly onItsWay: string | null;
  readonly typed: string;
  readonly problem: string | null;
  /** The chain a Coinbase Wallet is opened on to fill the box; null in the sandbox, where no wallet is paid. */
  readonly chain: number | null;
}

export interface SettingsView {
  readonly who: string;
  /** The name buyers read; null where none is set, which the banner says. */
  readonly lede: string | null;
  /** That Agentify approved the merchant for live sales; null otherwise. */
  readonly approval: string | null;
  readonly name: Readonly<{
    rule: string;
    /** Left out where the refusal on the page is that very sentence. */
    standing: string | null;
    value: string;
    problem: string | null;
  }>;
  readonly site: Readonly<{ rule: string; value: string; problem: string | null }>;
  readonly wallet: WalletView;
  /** Null in the sandbox, where nothing is ever deployed, and where no split can hold money. */
  readonly payout: PayoutView | null;
  readonly account: Readonly<{
    signOutEverywhere: string;
    analyticsOptedOut: boolean;
  }>;
}

const SETTLES: Readonly<Record<SurfaceMode, string>> = {
  test: "Your share of every TEST sale, paid in test USDC on Base Sepolia, is paid out to this wallet.",
  live: "Your share of every sale, paid in USDC on Base, is paid out to this wallet.",
  sandbox: "SANDBOX does not settle a payment.",
};

/**
 * The one chain a payout is sent on, and what its sender pays the fee with.
 * Multicall3 is at the same address on most chains, and sent on another one
 * the transaction can succeed and pay out nothing.
 */
const SENT_ON: Readonly<Record<Exclude<SurfaceMode, "sandbox">, string>> = {
  test: "To be paid now, send this transaction on Base Sepolia only, from any wallet with a little test ETH for the fee.",
  live: "To be paid now, send this transaction on Base only, from any wallet with a little ETH for the fee.",
};

/** When a merchant who sends nothing is paid: Agentify's own payout pays out every contract, whenever it is sent. */
const PAID_ON_NO_SET_DATE = "paid when Agentify next pays out every contract, on no set date.";

const sameAddress = (one: string, other: string): boolean =>
  one.toLowerCase() === other.toLowerCase();

const commissionOf = (mode: SurfaceMode, rate: CommissionRate): string => {
  const { commission, share } = percentagesOf(rate);
  return (
    `Agentify keeps ${commission} of every sale, a refunded one included. Buyers pay into a payout contract made for this wallet: it pays ${share} to the wallet and ${commission} to Agentify, and nobody can change that. The money waits in the contract until somebody pays it out: you, at any time, or Agentify, on no set date. Saving a wallet here is your agreement.` +
    (mode === "sandbox" ? " In the sandbox nothing is deployed and no money moves." : "")
  );
};

/**
 * The split recorded for this wallet, or null where the gateway named one for
 * another: two reads that straddled a change must not show a contract paying a
 * wallet that is not the one beside it.
 */
const splitBeside = (
  wallet: string,
  split: RecordedPayoutSplit | null,
  addressPage: string | null,
): SplitView | null =>
  split === null || !sameAddress(split.merchantWallet, wallet)
    ? null
    : {
        address: split.address,
        explorer: addressPage === null ? null : `${addressPage}${split.address}`,
      };

const payoutView = (
  mode: SurfaceMode,
  splits: PayoutSplits,
  walletChain: number | null,
): PayoutView | null => {
  const { payout } = splits;
  if (mode === "sandbox" || payout === null) return null;
  if (payout === "unbuilt") {
    return {
      kind: "unbuilt",
      said: "Agentify could not build the transaction that pays out your payout contracts as they are recorded, so there is none to send here. Buyers' payments wait in them until somebody pays them out.",
    };
  }
  if ("tooMany" in payout) {
    return {
      kind: "too_many",
      said: `You have ${payout.tooMany} payout contracts that can hold money, more than one transaction can pay out, so there is no transaction for you to send here. You are ${PAID_ON_NO_SET_DATE}`,
    };
  }
  const pays = payout.splits.map((split) => ({
    split: split.address,
    wallet: split.merchantWallet,
  }));
  const wallets = new Set(pays.map((pair) => pair.wallet.toLowerCase()));
  return {
    kind: "send",
    lead: `Buyers' payments wait in your payout contract until someone pays it out. ${SENT_ON[mode]}`,
    to: payout.to,
    data: payout.data,
    pays,
    after: `It carries no money and can take nothing from the wallet that sends it; ${
      wallets.size === 1
        ? "your share arrives in the same transaction"
        : "each share arrives in the wallet beside its contract, in the same transaction"
    }. Otherwise you are ${PAID_ON_NO_SET_DATE}`,
    chain: walletChain,
  };
};

export const settingsView = (
  mode: SurfaceMode,
  who: string,
  settings: Settings,
  press?: SettingsPress,
): SettingsView => {
  const {
    sellerName,
    sellerSite,
    payoutWallet,
    payoutSplits,
    addressPage,
    walletChain,
    liveApproval,
  } = settings;
  // The rule is the gateway's own, so no screen holds an opinion about which
  // setting publishing needs where; the approval goes in as unknown where it
  // was not read.
  const door = readinessOf(
    {
      sellerName,
      payoutWallet: payoutWallet.payout_wallet,
      liveApproval: liveApproval ?? UNKNOWN,
    },
    mode,
  );
  const refused = (kind: "name" | "site" | "wallet") =>
    press !== undefined && "problem" in press && press.kind === kind ? press : null;
  const name = refused("name");
  const site = refused("site");
  const wallet = refused("wallet");
  const saved = payoutWallet.payout_wallet;
  const pending = payoutWallet.pending;

  return {
    who,
    // A missing name is the banner's to say, with what it holds back.
    lede: sellerName === null ? null : `Your products are sold under ${sellerName}.`,
    // A missing approval is the banner's to say, over every page; Settings
    // says only that it was given.
    approval: mode === "live" && liveApproval === true ? APPROVAL_GIVEN : null,
    name: {
      rule: NAME_RULE,
      standing: name?.problem === NAME_CANNOT_BE_TAKEN_AWAY ? null : NAME_CANNOT_BE_TAKEN_AWAY,
      // A refused name stays in the box to be corrected; the lede still says
      // which name buyers read.
      value: name?.typed ?? sellerName ?? "",
      problem: name?.problem ?? null,
    },
    site: {
      rule: SITE_RULE,
      value: site?.typed ?? sellerSite ?? "",
      problem: site?.problem ?? null,
    },
    wallet: {
      // Where publishing asks for an address and none is set, the banner over
      // the page says what that holds back.
      purpose: !door.asked.includes(MERCHANT_FINDINGS.NO_PAYOUT_WALLET)
        ? `${SETTLES[mode]} Publishing does not ask for this address here, so it is optional.`
        : SETTLES[mode],
      commission: commissionOf(mode, payoutSplits.rate),
      saved,
      split: saved === null ? null : splitBeside(saved, payoutSplits.inForce, addressPage),
      pending:
        pending === null
          ? null
          : {
              wallet: pending.payout_wallet,
              takesEffectAt: pending.takes_effect_at,
              from: momentView(pending.takes_effect_at),
              split: splitBeside(pending.payout_wallet, payoutSplits.pending, addressPage),
            },
      notice: press?.kind === "wallet-notice" ? press.notice : null,
      rule: WALLET_RULE,
      waits: saved !== null && mode === "live" ? LIVE_CHANGE_WAITS : null,
      onItsWay: saved !== null && mode === "live" ? CHANGE_ON_ITS_WAY : null,
      typed: wallet?.typed ?? "",
      problem: wallet?.problem ?? null,
      chain: walletChain,
    },
    payout: saved === null ? null : payoutView(mode, payoutSplits, walletChain),
    account: {
      signOutEverywhere: SIGN_OUT_EVERYWHERE,
      analyticsOptedOut: settings.analyticsOptedOut,
    },
  };
};
