/**
 * What the settings screen shows: the name buyers read with the shop's site,
 * the payout wallet with the payout split buyers pay into and the transaction
 * that pays it out, and the account, built from one read of the gateway and
 * from what a press on the page just did.
 */

import { readinessOf, type SurfaceMode, UNKNOWN } from "@agentify/core";
import { type CommissionRate, percentagesOf } from "@agentify/core/published";
import type { RecordedPayoutSplit } from "@agentify/gateway";
import { MERCHANT_FINDINGS, type PayoutWallet } from "@nuanu-ai/agentify-contracts";
import { SIGN_OUT_EVERYWHERE } from "./control-labels.js";
import type { PayoutSplits } from "./gateway.js";
import { CHANGE_ON_ITS_WAY, LIVE_CHANGE_WAITS, WALLET_RULE } from "./payout-wallet.js";
import { NAME_RULE, nameRefusedSaying, SITE_RULE } from "./seller-name.js";
import { usdcOf } from "./shares.js";
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
 * Coinbase Wallet's button on a panel: offered on the chain it works on, or
 * the one line that says why there is none; null where the panel says
 * nothing of it, as in the sandbox.
 */
export type CoinbaseView = Readonly<{ chain: number }> | Readonly<{ absent: string }> | null;

/**
 * The one transaction that pays out every split that can hold the merchant's
 * money, as a wallet asks for it, or why there is none to send.
 */
export type PayoutView =
  | Readonly<{
      kind: "send";
      /**
       * What sending it now would bring, or that this is not known, and who
       * pays out if the merchant does not.
       */
      said: string;
      /** On which one chain, from what, the raw transaction is sent. */
      sentOn: string;
      /** The amount `said` names, with its currency; null where it is not known. */
      brings: string | null;
      to: string;
      /** What `to` is, said beside it. */
      toIs: string;
      data: string;
      /** Each split it pays out, beside the wallet written into it. */
      pays: readonly Readonly<{ split: string; wallet: string }>[];
      /** Whom the one transaction pays, and what sending it costs: said under either way of sending it. */
      paysBoth: string;
      /** Coinbase Wallet's way of sending it, on the chain `sentOn` names. */
      coinbase: CoinbaseView;
    }>
  | Readonly<{ kind: "nothing" | "too_many" | "unbuilt"; said: string }>;

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
  /** Coinbase Wallet's way of filling the box; null in the sandbox, where no wallet is paid. */
  readonly coinbase: CoinbaseView;
}

export interface SettingsView {
  readonly who: string;
  /** That Agentify approved the business for live sales; a missing approval is the banner's to say. */
  readonly approved: boolean;
  /** Each box with its rule, sent from here so the page's script carries no schema. */
  readonly name: Readonly<{ value: string; problem: string | null; rule: string }>;
  readonly site: Readonly<{ value: string; problem: string | null; rule: string }>;
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
 * and one test reads them all. Only the network's own count of what a payout
 * would bring says there is money in a payout contract; no other note does,
 * so a merchant with no sale yet reads the same words.
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
  multicall3: "Multicall3, a public contract, not Agentify's.",
  brings: (amount: string, one: boolean): string =>
    `Sent now, it would bring ${amount} ${one ? "to your wallet" : "to the wallets beside your payout contracts"}, as the network showed when this page was drawn.`,
  unknown:
    "Agentify could not read from the network what this payout would bring. Sending it anyway does no harm: it pays out only what is there.",
  counted: "A payout already sent is still counted here until the network carries it out.",
  nothing:
    "A payout sent now would bring nothing, as the network showed when this page was drawn. Once a buyer pays into your payout contract, it shows here.",
  noCoinbaseOnTest:
    "Coinbase Wallet can't send this payout on the test network, Base Sepolia, so send it from another wallet.",
  orAgentify: "If nobody sends it, Agentify's next payout does the same, on no fixed date.",
  paysBoth: (commission: string): string =>
    `This one transaction pays your share and Agentify's ${commission} together, and sending it costs only the network fee.`,
  tooMany: (count: number): string =>
    `You have ${count} payout contracts, more than one transaction can carry. Agentify's next payout covers them all, on no fixed date.`,
  // Agentify's own payout refuses every contract the merchant's refuses, and
  // refuses as a whole, so it does not cover this one in the meantime.
  unbuilt:
    "Agentify could not build your payout transaction. The fault is on Agentify's side, and until it is fixed Agentify's own payouts cannot move what is in your payout contracts either. Write to admin@agentify.ad about it.",
});

/** The token a payout brings on each channel that settles. */
const TOKEN_ON: Readonly<Record<Exclude<SurfaceMode, "sandbox">, string>> = {
  test: "test USDC",
  live: "USDC",
};

/**
 * Where each of Coinbase Wallet's buttons is offered, by the EIP-155 chain it
 * would work on, with the line its panel says where it is not. Connecting a
 * Coinbase Wallet works on Base Sepolia, but Coinbase's window refuses
 * transactions there from the wallets it creates now, so the test channel
 * offers the box's button and not the payout's. A chain not written here
 * offers neither, without a word.
 */
const COINBASE_ON: Readonly<
  Record<number, Readonly<{ box: true | string; payout: true | string }>>
> = {
  8453: { box: true, payout: true },
  84532: {
    box: true,
    payout: PAYOUT_NOTES.noCoinbaseOnTest,
  },
};

const coinbaseOn = (chain: number | null, panel: "box" | "payout"): CoinbaseView => {
  const on = chain === null ? undefined : COINBASE_ON[chain]?.[panel];
  return chain === null || on === undefined ? null : on === true ? { chain } : { absent: on };
};

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

/**
 * The payout as the chain's run of it answered when the page was drawn. A
 * payout that would bring nothing is not offered; one whose amount is not
 * known is, since it pays out only what is there, and the page says it does
 * not know rather than that nothing waits.
 */
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
  const { transaction, brings } = payout;
  if (brings === 0n) {
    return { kind: "nothing", said: PAYOUT_NOTES.nothing };
  }
  const pays = transaction.splits.map((split) => ({
    split: split.address,
    wallet: split.merchantWallet,
  }));
  const one = new Set(pays.map((pair) => pair.wallet.toLowerCase())).size === 1;
  const amount = brings === UNKNOWN ? null : `${usdcOf(brings)} ${TOKEN_ON[mode]}`;
  return {
    kind: "send",
    said: [
      amount === null ? PAYOUT_NOTES.unknown : PAYOUT_NOTES.brings(amount, one),
      PAYOUT_NOTES.counted,
      PAYOUT_NOTES.orAgentify,
    ].join(" "),
    sentOn: PAYOUT_NOTES.sentOn[mode],
    brings: amount,
    to: transaction.to,
    toIs: PAYOUT_NOTES.multicall3,
    data: transaction.data,
    pays,
    paysBoth: PAYOUT_NOTES.paysBoth(percentagesOf(splits.rate).commission),
    coinbase: coinbaseOn(walletChain, "payout"),
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
      rule: NAME_RULE,
    },
    site: {
      value: site === null || site.typed === "" ? (sellerSite ?? "") : site.typed,
      problem: site?.problem ?? null,
      rule: SITE_RULE,
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
      coinbase: coinbaseOn(walletChain, "box"),
    },
    payout: saved === null ? null : payoutView(mode, payoutSplits, walletChain),
    account: {
      signOutEverywhere: SIGN_OUT_EVERYWHERE,
      analyticsOptedOut: settings.analyticsOptedOut,
    },
  };
};
