/**
 * The address a merchant's share arrives at: the rule it is held to and what
 * is said about it. A buyer's agent pays the merchant's payout split, a
 * contract nobody owns that keeps the money until somebody pays it out, and
 * then pays this address its share and Agentify its commission, and nobody
 * else. An address is enough to be paid with; a private key or recovery
 * phrase would be enough to spend with, so there is nowhere to type either,
 * and the settings screen says so.
 *
 * A missing address gets no banner, unlike a missing name: where nothing
 * settles, publishing without an address is not refused, so a banner would
 * claim something that is not happening.
 */

import type { NotAPayoutWallet } from "@agentify/gateway";
import { EvmAddressSchema } from "@nuanu-ai/agentify-contracts";

/**
 * The rule is the contract's schema, applied by asking it. The sentence also
 * says that nothing here looks the address up on a chain, so a merchant knows
 * their own check is the only one there is.
 */
export const WALLET_RULE =
  "0x followed by forty letters and digits. We check its spelling, not its network or owner, so copy it from your wallet.";

/**
 * So a change that does not apply at once is not read as one that failed, and
 * so nobody expects the money already in the current contract to follow it:
 * that contract pays the wallet written into it, for good.
 */
export const LIVE_CHANGE_WAITS =
  "A new wallet starts forty-eight hours after we email everyone on your account." +
  " Money already in your payout contract is still paid to your current wallet.";

/**
 * How long a change of the address is waited for: longer than a screen's ten
 * seconds, because on live the gateway answers only after every message about
 * it is handed to the mail provider, which may take twenty seconds
 * (`ANNOUNCEMENT_ANSWER_MS` in the gateway). Stopping sooner would tell a
 * person the gateway did not answer while their change was being recorded.
 */
export const WALLET_CHANGE_MS = 30_000;

/** Said while a change is on its way on live, so that wait does not read as a frozen page. */
export const CHANGE_ON_ITS_WAY = `Emailing everyone on your account first. This can take up to ${WALLET_CHANGE_MS / 1_000} seconds.`;

export const WALLET_NEEDED = "Paste your wallet's address.";

/**
 * On this field, not knowing whether it was saved is the difference between
 * money arriving where it was meant and somewhere else.
 */
const NOTHING_WAS_SAVED = "It was not saved.";

/** What in an address of the wrong shape makes it one: its start, a character, or its length. */
const wrongInTheShape = (address: string): string => {
  if (!address.startsWith("0x")) return "A wallet address starts with 0x.";
  const strange = [...new Set(address.slice(2).match(/[^0-9a-fA-F]/gu) ?? [])];
  if (strange.length > 0) {
    return `${strange.map((one) => (one === " " ? "A space" : `“${one}”`)).join(", ")} can't be in a wallet address.`;
  }
  return `This is ${address.length} characters long, and a wallet address has 42.`;
};

/**
 * Two rules fail differently: forty characters that are not an address at all,
 * and forty of the right shape whose capitals disagree, which means a character
 * is wrong. "That is not an address" would be untrue of the second and leave a
 * merchant re-reading a spelling that looks fine. A mistyped address is never
 * told to drop its capitals, which are the only warning of the typo.
 */
export const whatIsWrongWithTheWallet = (address: string): string | null => {
  const read = EvmAddressSchema.safeParse(address);
  if (read.success) {
    return null;
  }
  return read.error.issues.every((issue) => issue.code === "custom")
    ? `This address has a typo: wallets mark every address with a check in its capital letters, and these don't match. Copy it again from your wallet and paste it whole. ${NOTHING_WAS_SAVED}`
    : `${wrongInTheShape(address)} A wallet address is 0x followed by forty letters and digits. ${NOTHING_WAS_SAVED}`;
};

/**
 * Why an address cannot be a payout wallet, as the screen tells it: the
 * gateway's own reasons, with a payout contract told apart by whose it is,
 * since a share paid into another merchant's becomes that merchant's.
 */
export type NotAWallet =
  | Exclude<NotAPayoutWallet, "payout_split">
  | "own_payout_split"
  | "another_merchants_payout_split";

/**
 * What an address is that a merchant's share could never come back from, said
 * on the screen that asked for it. A split pays the wallet written into it for
 * good, so saving one of these would lose the share or hand it to somebody
 * else.
 */
export const NOT_A_PAYOUT_WALLET: Readonly<Record<NotAWallet, string>> = {
  zero_address: `This is the zero address, which nobody holds, so a share paid to it is lost. ${NOTHING_WAS_SAVED}`,
  commission_wallet: `This is Agentify's commission wallet, not yours, so your share would go to Agentify. ${NOTHING_WAS_SAVED}`,
  split_factory: `This is the contract that creates payout contracts, not a wallet, so your share could never come back from it. ${NOTHING_WAS_SAVED}`,
  split_implementation: `This is the code every payout contract runs, not a wallet, so your share could never come back from it. ${NOTHING_WAS_SAVED}`,
  split_warehouse: `This is the 0xSplits warehouse a payout pays from, not a wallet, so your share could never come back from it. ${NOTHING_WAS_SAVED}`,
  multicall3: `This is Multicall3, the public contract a payout is sent to, not a wallet: anybody could take a share paid to it. ${NOTHING_WAS_SAVED}`,
  usdc: `This is the USDC token contract, not a wallet, so your share could never come back from it. ${NOTHING_WAS_SAVED}`,
  own_payout_split: `This is one of your own payout contracts, not a wallet: a share paid to it would be split again, with Agentify's commission taken a second time, on its way to the wallet that contract pays. ${NOTHING_WAS_SAVED}`,
  another_merchants_payout_split: `This is another business's payout contract, not a wallet: a share paid to it would go to that business. ${NOTHING_WAS_SAVED}`,
};

/** The address a screen read from the gateway; null where none is set. */
export interface PayoutWallet {
  readonly wallet: string | null;
}
