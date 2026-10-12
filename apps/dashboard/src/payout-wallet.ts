/**
 * The address a merchant's money arrives at: the rule it is held to and what
 * is said about it. A buyer's agent pays that address directly and nothing is
 * held in between. An address is enough to be paid with; a private key or
 * recovery phrase would be enough to spend with, so there is nowhere to type
 * either, and the settings screen says so.
 *
 * A missing address gets no banner, unlike a missing name: where nothing
 * settles, publishing without an address is not refused, so a banner would
 * claim something that is not happening.
 */

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
  " is sent a message about it. Until then your sales are paid into the address above.";

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

/** The address a screen read from the gateway; null where none is set. */
export interface PayoutWallet {
  readonly wallet: string | null;
}
