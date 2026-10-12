/**
 * What the settings screen shows: the name buyers read with the shop's site,
 * the payout wallet, and the account, built from one read of the gateway and
 * from what a press on the page just did.
 */

import { readinessOf, type SurfaceMode, UNKNOWN } from "@agentify/core";
import { MERCHANT_FINDINGS, type PayoutWallet } from "@nuanu-ai/agentify-contracts";
import { SIGN_OUT_EVERY_OTHER_DEVICE } from "./control-labels.js";
import { CHANGE_ON_ITS_WAY, LIVE_CHANGE_WAITS, WALLET_RULE } from "./payout-wallet.js";
import { NAME_CANNOT_BE_TAKEN_AWAY, NAME_RULE, SITE_RULE } from "./seller-name.js";
import { type FrameView, type MomentView, momentView } from "./views.js";
import { APPROVAL_GIVEN, APPROVAL_PENDING } from "./words.js";

/** The gateway's answers the page is drawn from, all read together. */
export interface Settings {
  readonly sellerName: string | null;
  readonly sellerSite: string | null;
  readonly payoutWallet: PayoutWallet;
  /** Read on the live channel only. */
  readonly liveApproval?: boolean;
}

/** What a press did, where it answers with the page rather than sending the browser on. */
export type SettingsPress =
  | Readonly<{ kind: "name" | "site" | "wallet"; problem: string; typed: string }>
  | Readonly<{ kind: "wallet-notice" | "account"; notice: string }>;

export interface WalletView {
  readonly purpose: string;
  /** As the gateway answered it, in the spelling a wallet shows; null where none is set. */
  readonly saved: string | null;
  readonly pending: null | Readonly<{ wallet: string; takesEffectAt: string; from: MomentView }>;
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
  readonly account: Readonly<{ signOutOthers: string; notice: string | null }>;
}

const SETTLES: Readonly<Record<SurfaceMode, string>> = {
  test: "TEST settles test USDC on Base Sepolia to this address.",
  live: "LIVE settles real USDC on Base mainnet to this address.",
  sandbox: "SANDBOX does not settle a payment.",
};

export const settingsView = (
  mode: SurfaceMode,
  who: string,
  settings: Settings,
  press?: SettingsPress,
): SettingsView => {
  const { sellerName, sellerSite, payoutWallet, liveApproval } = settings;
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
      saved,
      pending:
        pending === null
          ? null
          : {
              wallet: pending.payout_wallet,
              takesEffectAt: pending.takes_effect_at,
              from: momentView(pending.takes_effect_at),
            },
      notice: press?.kind === "wallet-notice" ? press.notice : null,
      rule: WALLET_RULE,
      waits: saved !== null && mode === "live" ? LIVE_CHANGE_WAITS : null,
      onItsWay: saved !== null && mode === "live" ? CHANGE_ON_ITS_WAY : null,
      typed: wallet?.typed ?? "",
      problem: wallet?.problem ?? null,
    },
    account: {
      signOutOthers: SIGN_OUT_EVERY_OTHER_DEVICE,
      notice: press?.kind === "account" ? press.notice : null,
    },
  };
};
