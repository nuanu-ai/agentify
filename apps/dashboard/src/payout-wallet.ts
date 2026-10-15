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
  "Paste an EVM address: 0x followed by 40 hexadecimal characters. Use the spelling from your" +
  " wallet or all lowercase. We check the format and checksum, not the network or the owner, so" +
  " copy the address from your wallet instead of typing it.";

/** So a change that does not apply at once is not read as one that failed. */
export const LIVE_CHANGE_WAITS =
  "A different address takes effect forty-eight hours after every account of your merchant" +
  " is sent a message about it. Until then buyers pay into the payout contract of the address above.";

/**
 * How long a change of the address is waited for: longer than a screen's ten
 * seconds, because on live the gateway answers only after every message about
 * it is handed to the mail provider, which may take twenty seconds
 * (`ANNOUNCEMENT_ANSWER_MS` in the gateway). Stopping sooner would tell a
 * person the gateway did not answer while their change was being recorded.
 */
export const WALLET_CHANGE_MS = 30_000;

/** Said while a change is on its way on live, so that wait does not read as a frozen page. */
export const CHANGE_ON_ITS_WAY =
  "Asking for the change. Every account of your merchant is sent a message about a different" +
  ` address before it is recorded, which can take up to ${WALLET_CHANGE_MS / 1_000} seconds.`;

export const WALLET_NEEDED =
  "An address is needed here. Copy it out of the wallet you want to be paid in rather than" +
  " typing it, and paste the whole of it.";

/**
 * On this field, not knowing whether it was saved is the difference between
 * money arriving where it was meant and somewhere else.
 */
const NOTHING_WAS_SAVED = "It was not saved.";

/**
 * Two rules fail differently: forty characters that are not an address at all,
 * and forty of the right shape whose capitals disagree, which means a character
 * is wrong. "That is not an address" would be untrue of the second and leave a
 * merchant re-reading a spelling that looks fine.
 */
export const whatIsWrongWithTheWallet = (address: string): string | null => {
  const read = EvmAddressSchema.safeParse(address);
  if (read.success) {
    return null;
  }
  const said = read.error.issues[0]?.message;
  return said === undefined
    ? NOTHING_WAS_SAVED
    : `${said.slice(0, 1).toUpperCase()}${said.slice(1)}. ${NOTHING_WAS_SAVED}`;
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
  another_merchants_payout_split: `This is another merchant's payout contract, not a wallet: a share paid to it would go to that merchant. ${NOTHING_WAS_SAVED}`,
};

/** The address a screen read from the gateway; null where none is set. */
export interface PayoutWallet {
  readonly wallet: string | null;
}
