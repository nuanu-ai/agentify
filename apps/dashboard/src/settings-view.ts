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
import { nameRefusedSaying } from "./seller-name.js";
import { type CommissionRate, percentagesOf } from "./shares.js";
import { type MomentView, momentView } from "./views.js";

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

/** A payout split shown whole beside the wallet it pays. */
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
      /** What the transaction does, and who pays out if the merchant does not. */
      said: string;
      /** On which one chain, from what, the raw transaction is sent. */
      sentOn: string;
      to: string;
      /** What `to` is, said beside it. */
      toIs: string;
      data: string;
      /** Each split it pays out, beside the wallet written into it. */
      pays: readonly Readonly<{ split: string; wallet: string }>[];
      /** What sending it takes from the wallet that sends it. */
      after: string;
      /** The chain a Coinbase Wallet sends it on, the one `sentOn` names; null where there is none. */
      chain: number | null;
    }>
  | Readonly<{ kind: "too_many" | "unbuilt"; said: string }>;

/**
 * What a press on the wallet did that is not what it looked like: typing the
 * wallet paid now cancelled a waiting change, or a cancel arrived after the
 * change had applied. Each names the wallets it is about, which the screen
 * shows whole.
 */
export type WalletNotice =
  | Readonly<{ kind: "cancelled"; paid: string }>
  | Readonly<{
      kind: "landed";
      /** The wallet the change applied, paid now. */
      wallet: string;
      /** When it applied; null where the page that pressed did not say. */
      at: string | null;
      /** The wallet paid before, where known. */
      before: string | null;
      /** Whether the press asked for `before` back, which then waits as a change of its own. */
      askedBack: boolean;
    }>;

/** What a press did, where it answers with the page rather than sending the browser on. */
export type SettingsPress =
  | Readonly<{ kind: "name" | "site" | "wallet"; problem: string; typed: string }>
  | Readonly<{ kind: "wallet-notice"; notice: WalletNotice }>;

/** A notice as the screen draws it, with its moment ready for the page's clock. */
export type WalletNoticeView =
  | Readonly<{ kind: "cancelled"; paid: string }>
  | Readonly<{
      kind: "landed";
      wallet: string;
      at: MomentView | null;
      before: string | null;
      askedBack: boolean;
    }>;

export interface WalletView {
  /** Where the share is paid and in what, or that nothing is paid here. */
  readonly purpose: string;
  /** The rate, and that saving a wallet agrees to it: said by the button that saves. */
  readonly commission: string;
  /** As the gateway answered it, in the spelling a wallet shows; null where none is set. */
  readonly saved: string | null;
  /** The split buyers pay into, where one is recorded for the saved wallet. */
  readonly split: SplitView | null;
  readonly pending: null | Readonly<{
    wallet: string;
    takesEffectAt: string;
    from: MomentView;
  }>;
  readonly notice: WalletNoticeView | null;
  /** The address's form and what is checked, under the box. */
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
  /** That Agentify approved the business for live sales; a missing approval is the banner's to say. */
  readonly approved: boolean;
  readonly name: Readonly<{ value: string; problem: string | null }>;
  readonly site: Readonly<{ value: string; problem: string | null }>;
  readonly wallet: WalletView;
  /** Null in the sandbox, where nothing is ever deployed, and where no split can hold money. */
  readonly payout: PayoutView | null;
  readonly account: Readonly<{
    signOutEverywhere: string;
    analyticsOptedOut: boolean;
  }>;
}

const PAID_IN: Readonly<Record<Exclude<SurfaceMode, "sandbox">, string>> = {
  test: "Your share of each sale is paid here, in test USDC on Base Sepolia.",
  live: "Your share of each sale is paid here, in USDC on Base.",
};

/** Where publishing asks for no address, because no payment settles. */
const OPTIONAL = "Nothing is settled or paid out here, so this address is optional.";

/**
 * Every note Getting paid says, by the state it is in, so each is written once
 * and one test reads them all. The page reads which payout contracts there
 * are and never what they hold, so no note says there is money in one: a
 * merchant with no sale yet reads the same words.
 */
export const PAYOUT_NOTES = Object.freeze({
  /**
   * The one chain a payout is sent on, and what its sender pays the fee with.
   * Multicall3 is at the same address on most chains, and sent on another one
   * the transaction can succeed and pay out nothing.
   */
  sentOn: {
    test: "Send this transaction on Base Sepolia only, from any wallet with a little test ETH for the fee.",
    live: "Send this transaction on Base only, from any wallet with a little ETH for the fee.",
  } satisfies Readonly<Record<Exclude<SurfaceMode, "sandbox">, string>>,
  multicall3: "Multicall3, a public contract, not ours.",
  toYourWallet: (contracts: number): string =>
    `One transaction pays out your payout ${contracts === 1 ? "contract" : "contracts"} to your wallet.`,
  toEachWallet: "One transaction pays out each payout contract to the wallet written into it.",
  orAgentify: "If nobody sends it, Agentify's next payout does. It has no fixed date.",
  fromTheSender: "It moves no money out of the wallet that sends it.",
  tooMany: (count: number): string =>
    `You have ${count} payout contracts, more than one transaction can pay out. Agentify's next payout covers them all. It has no fixed date.`,
  unbuilt:
    "We couldn't prepare your payout transaction. The fault is on our side. If you see this again, write to admin@agentify.ad.",
});

const sameAddress = (one: string, other: string): boolean =>
  one.toLowerCase() === other.toLowerCase();

const commissionOf = (rate: CommissionRate): string =>
  `Agentify keeps ${percentagesOf(rate).commission} of each sale, refunded sales included. Saving a wallet means you agree to this fee.`;

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
    return { kind: "unbuilt", said: PAYOUT_NOTES.unbuilt };
  }
  if ("tooMany" in payout) {
    return { kind: "too_many", said: PAYOUT_NOTES.tooMany(payout.tooMany) };
  }
  const pays = payout.splits.map((split) => ({
    split: split.address,
    wallet: split.merchantWallet,
  }));
  const wallets = new Set(pays.map((pair) => pair.wallet.toLowerCase()));
  const goes =
    wallets.size === 1 ? PAYOUT_NOTES.toYourWallet(pays.length) : PAYOUT_NOTES.toEachWallet;
  return {
    kind: "send",
    said: `${goes} ${PAYOUT_NOTES.orAgentify}`,
    sentOn: PAYOUT_NOTES.sentOn[mode],
    to: payout.to,
    toIs: PAYOUT_NOTES.multicall3,
    data: payout.data,
    pays,
    after: PAYOUT_NOTES.fromTheSender,
    chain: walletChain,
  };
};

const noticeView = (notice: WalletNotice): WalletNoticeView =>
  notice.kind === "cancelled"
    ? notice
    : { ...notice, at: notice.at === null ? null : momentView(notice.at) };

/** Said where a box that holds no name is saved empty, where there is no name to keep. */
const NAME_EMPTY = "Enter a seller name.";

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
    approved: mode === "live" && liveApproval === true,
    name: {
      // A box emptied and refused shows the name buyers still read; a refused
      // name stays in the box to be corrected.
      value: name === null || name.typed === "" ? (sellerName ?? "") : name.typed,
      // The box holds what was refused, so the refusal says which name buyers
      // still read.
      problem:
        name === null
          ? null
          : name.typed === "" && sellerName === null
            ? NAME_EMPTY
            : `${nameRefusedSaying(name.typed, name.problem)}${
                name.typed === "" || sellerName === null ? "" : ` Buyers still see “${sellerName}”.`
              }`,
    },
    site: {
      value: site === null || site.typed === "" ? (sellerSite ?? "") : site.typed,
      problem: site?.problem ?? null,
    },
    wallet: {
      // Where publishing asks for an address and none is set, the banner over
      // the page says what that holds back.
      purpose:
        mode !== "sandbox" && door.asked.includes(MERCHANT_FINDINGS.NO_PAYOUT_WALLET)
          ? PAID_IN[mode]
          : OPTIONAL,
      commission: commissionOf(payoutSplits.rate),
      saved,
      split: saved === null ? null : splitBeside(saved, payoutSplits.inForce, addressPage),
      pending:
        pending === null
          ? null
          : {
              wallet: pending.payout_wallet,
              takesEffectAt: pending.takes_effect_at,
              from: momentView(pending.takes_effect_at),
            },
      notice: press?.kind === "wallet-notice" ? noticeView(press.notice) : null,
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
