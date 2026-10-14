/**
 * What the settings screen shows: the name buyers read with the shop's site,
 * the payout wallet with the payout split buyers pay into and the transaction
 * that pays it out, and the account, built from one read of the gateway and
 * from what a press on the page just did.
 */

import { readinessOf, type SurfaceMode, UNKNOWN } from "@agentify/core";
import type { RecordedPayoutSplit } from "@agentify/gateway";
import { MERCHANT_FINDINGS, type PayoutWallet } from "@nuanu-ai/agentify-contracts";
import { SIGN_OUT_EVERY_OTHER_DEVICE } from "./control-labels.js";
import type { PayoutSplits } from "./gateway.js";
import { CHANGE_ON_ITS_WAY, LIVE_CHANGE_WAITS, WALLET_RULE } from "./payout-wallet.js";
import { NAME_CANNOT_BE_TAKEN_AWAY, NAME_RULE, SITE_RULE } from "./seller-name.js";
import { type CommissionRate, percentagesOf, percentOf } from "./shares.js";
import { type FrameView, type MomentView, momentView } from "./views.js";
import { APPROVAL_GIVEN, APPROVAL_PENDING } from "./words.js";

/**
 * What the page is drawn from: the gateway's answers, all read together, and
 * where this deployment's chain shows an address.
 */
export interface Settings {
  readonly sellerName: string | null;
  readonly sellerSite: string | null;
  readonly payoutWallet: PayoutWallet;
  readonly payoutSplits: PayoutSplits;
  /** The dashboard configuration's; null where there is none, as in the sandbox. */
  readonly addressPage: string | null;
  /** Read on the live channel only. */
  readonly liveApproval?: boolean;
}

/** A payout split shown whole beside the wallet it pays. */
export interface SplitView {
  readonly address: string;
  /** Where the chain shows what it holds; null where there is no such page. */
  readonly explorer: string | null;
  readonly pays: string;
}

/**
 * The one transaction that pays out every split that can hold the merchant's
 * money, as a wallet asks for it, or why there is none to send.
 */
export type PayoutView =
  | Readonly<{
      kind: "send";
      chain: string;
      /** Who sends it and with what. */
      from: string;
      to: string;
      data: string;
      /** Each split it pays out, beside the wallet written into it. */
      pays: readonly Readonly<{ split: string; wallet: string }>[];
      arrives: string;
      withoutEth: string;
    }>
  | Readonly<{ kind: "too_many" | "unbuilt"; said: string }>;

/** What a press did, where it answers with the page rather than sending the browser on. */
export type SettingsPress =
  | Readonly<{ kind: "name" | "site" | "wallet"; problem: string; typed: string }>
  | Readonly<{ kind: "wallet-notice" | "account"; notice: string }>;

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
}

export interface SettingsView {
  readonly frame: FrameView;
  readonly who: string;
  readonly lede: string;
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
  readonly account: Readonly<{ signOutOthers: string; notice: string | null }>;
}

const SETTLES: Readonly<Record<SurfaceMode, string>> = {
  test: "Your share of every TEST sale, paid in test USDC on Base Sepolia, is paid out to this wallet.",
  live: "Your share of every sale, paid in USDC on Base, is paid out to this wallet.",
  sandbox: "SANDBOX does not settle a payment.",
};

/** The chain a payout is sent on, and what its sender pays the network fee with. */
const SENT_ON: Readonly<Record<Exclude<SurfaceMode, "sandbox">, { chain: string; from: string }>> =
  {
    test: {
      chain: "Base Sepolia",
      from: "To be paid now, send one transaction on Base Sepolia from any wallet that holds a little test ETH for the network fee; a Base Sepolia faucet gives test ETH for free.",
    },
    live: {
      chain: "Base",
      from: "To be paid now, send one transaction on Base from any wallet that holds a little ETH for the network fee, usually under one cent.",
    },
  };

const sameAddress = (one: string, other: string): boolean =>
  one.toLowerCase() === other.toLowerCase();

const commissionOf = (mode: SurfaceMode, rate: CommissionRate): string => {
  const { commission, share } = percentagesOf(rate);
  return (
    `Agentify keeps ${commission} of every sale. Buyers pay into a payout contract made for this wallet, which sends ${share} to the wallet and ${commission} to Agentify; nobody, Agentify included, can send the money anywhere else. Saving a wallet here means you agree to this.` +
    (mode === "sandbox" ? " In the sandbox the contract is never deployed and no money moves." : "")
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
  above: string,
): SplitView | null =>
  split === null || !sameAddress(split.merchantWallet, wallet)
    ? null
    : {
        address: split.address,
        explorer: addressPage === null ? null : `${addressPage}${split.address}`,
        pays: `It sends ${percentOf(split.merchantAllocation, split.totalAllocation)} to ${above} and ${percentOf(split.commissionAllocation, split.totalAllocation)} to Agentify.`,
      };

const payoutView = (mode: SurfaceMode, splits: PayoutSplits): PayoutView | null => {
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
      said: `You have ${payout.tooMany} payout contracts that can hold money, more than one transaction can pay out, so there is no transaction for you to send here. Agentify pays them out.`,
    };
  }
  const { chain, from } = SENT_ON[mode];
  const pays = payout.splits.map((split) => ({
    split: split.address,
    wallet: split.merchantWallet,
  }));
  const wallets = new Set(pays.map((pair) => pair.wallet.toLowerCase()));
  return {
    kind: "send",
    chain,
    from,
    to: payout.to,
    data: payout.data,
    pays,
    arrives:
      wallets.size === 1
        ? "Your share arrives in your wallet in the same transaction."
        : "Each share arrives in the wallet beside its contract, in the same transaction.",
    withoutEth: `No ETH on ${chain}? You are paid when Agentify pays out.`,
  };
};

export const settingsView = (
  mode: SurfaceMode,
  who: string,
  settings: Settings,
  press?: SettingsPress,
): SettingsView => {
  const { sellerName, sellerSite, payoutWallet, payoutSplits, addressPage, liveApproval } =
    settings;
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
    frame: { unnamed: false },
    who,
    lede:
      sellerName === null
        ? `You have not set a seller name yet.${door.missing.includes(MERCHANT_FINDINGS.NO_SELLER_NAME) ? " Until you do, cards cannot be published." : ""}`
        : `Your products are sold under ${sellerName}.`,
    approval:
      mode === "live" && liveApproval !== undefined
        ? liveApproval
          ? APPROVAL_GIVEN
          : APPROVAL_PENDING
        : null,
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
      purpose: !door.asked.includes(MERCHANT_FINDINGS.NO_PAYOUT_WALLET)
        ? `${SETTLES[mode]} Publishing does not ask for this address here, so it is optional.`
        : door.missing.includes(MERCHANT_FINDINGS.NO_PAYOUT_WALLET)
          ? `${SETTLES[mode]} Until you set one, publishing a card is refused.`
          : SETTLES[mode],
      commission: commissionOf(mode, payoutSplits.rate),
      saved,
      split:
        saved === null
          ? null
          : splitBeside(saved, payoutSplits.inForce, addressPage, "the wallet above"),
      pending:
        pending === null
          ? null
          : {
              wallet: pending.payout_wallet,
              takesEffectAt: pending.takes_effect_at,
              from: momentView(pending.takes_effect_at),
              split: splitBeside(
                pending.payout_wallet,
                payoutSplits.pending,
                addressPage,
                "the waiting wallet",
              ),
            },
      notice: press?.kind === "wallet-notice" ? press.notice : null,
      rule: WALLET_RULE,
      waits: saved !== null && mode === "live" ? LIVE_CHANGE_WAITS : null,
      onItsWay: saved !== null && mode === "live" ? CHANGE_ON_ITS_WAY : null,
      typed: wallet?.typed ?? "",
      problem: wallet?.problem ?? null,
    },
    payout: saved === null ? null : payoutView(mode, payoutSplits),
    account: {
      signOutOthers: SIGN_OUT_EVERY_OTHER_DEVICE,
      notice: press?.kind === "account" ? press.notice : null,
    },
  };
};
