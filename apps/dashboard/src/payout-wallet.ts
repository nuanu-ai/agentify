/**
 * The settings block where a merchant gives the address their money arrives at.
 * A buyer's agent pays that address directly and nothing is held in between. An
 * address is enough to be paid with; a private key or recovery phrase would be
 * enough to spend with, so there is nowhere to type either, and the screen says
 * so.
 *
 * A missing address gets no banner, unlike a missing name: where nothing
 * settles, publishing without an address is not refused, so a banner would
 * claim something that is not happening.
 *
 * A saved address is shown whole, never with the middle elided: first-few,
 * dots, last-few is the one presentation under which a wrong address and the
 * right one look identical. It is shown as the gateway answered it, because the
 * gateway keeps the checksummed mixed-case spelling a wallet displays,
 * whichever accepted spelling it was given.
 */

import { EvmAddressSchema, MERCHANT_FINDINGS } from "@nuanu-ai/agentify-contracts";

import { escaped, when } from "./html.js";
import { readinessSeenBy, type Viewer } from "./screens.js";

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

/** The refusal travels with the address because one block draws both. */
export interface PayoutWallet {
  /** Null where none is set. */
  readonly wallet: string | null;
  /** Absent or null where nothing waits. */
  readonly pending?: { readonly wallet: string; readonly takesEffectAt: string } | null;
  /**
   * Set when a press could not be a cancel because the change had already taken
   * effect.
   */
  readonly notice?: string;
  readonly problem?: string;
  /** Kept so the merchant can correct it rather than retype it. */
  readonly typed?: string;
}

/**
 * The groups are spans with nothing between them, so the gaps are the
 * stylesheet's: a copied address pastes as an address, not as something no
 * wallet accepts.
 */
const inFours = (address: string): string => {
  const lead = address.slice(0, 2);
  const rest = address.slice(2);
  const groups = rest.match(/.{1,4}/g) ?? [];
  return `<span class="lead">${escaped(lead)}</span>${groups
    .map((group) => `<span class="quad">${escaped(group)}</span>`)
    .join("")}`;
};

const savedAddress = (address: string): string => `
  <div class="saved">
    <div class="label">Saved here</div>
    <div class="address">${inFours(address)}</div>
    <p class="under">The full address, spelled the way your wallet shows it. Check it against your wallet, one group of characters at a time.</p>
  </div>`;

/**
 * The announcement says the change takes effect only if this screen shows it,
 * so the screen must always show it. Cancel is a form post from this page only,
 * and it says it also ends every other session. The form carries the change it
 * showed and the address paid beside it, so a press arriving after the change
 * took effect is told apart from a cancel.
 */
const pendingAddress = (
  base: string,
  paid: string | null,
  pending: NonNullable<PayoutWallet["pending"]>,
): string => `
  <div class="saved">
    <div class="label">Waiting to replace it</div>
    <div class="address">${inFours(pending.wallet)}</div>
    <p class="under">From ${when(pending.takesEffectAt)} your sales are paid into this address instead. Every account of your merchant was sent a message about it. If nobody at your business asked for it, cancel it; cancelling also signs out every session of your merchant but this one.</p>
    <form class="inline" method="post" action="${escaped(base)}/settings/payout-wallet/cancel">
      <input type="hidden" name="waiting" value="${escaped(pending.wallet)}">
      <input type="hidden" name="waiting_from" value="${escaped(pending.takesEffectAt)}">
      <input type="hidden" name="paid" value="${escaped(paid ?? "")}">
      <button class="button button-secondary" type="submit">Cancel this change</button>
    </form>
  </div>`;

/**
 * Draws nothing where the screen did not ask the gateway for the address: a
 * block drawn from an address nobody fetched would tell a merchant they have
 * none when they may.
 *
 * The box starts empty beside a saved address, because a box you can type over
 * cannot show what is stored. With a change waiting, its form carries what the
 * cancel form does, so an address typed after that change took effect is
 * answered as Cancel would be. A refused address is shown whole under its
 * refusal, because a box on a phone shows only part of it and the capitals
 * refusal asks the merchant to find one wrong character.
 */
export const payoutWalletBlock = (viewer: Viewer): string => {
  const { base, payout } = viewer;
  if (payout === undefined) {
    return "";
  }
  const { wallet, pending, problem, typed, notice } = payout;
  const settles =
    viewer.mode === "test"
      ? "TEST settles test USDC on Base Sepolia to this address."
      : viewer.mode === "live"
        ? "LIVE settles real USDC on Base mainnet to this address."
        : "SANDBOX does not settle a payment.";
  // Whether publishing needs the address is the gateway's rule; what the
  // channel settles, and on which chain, is this block's.
  const door = readinessSeenBy(viewer);
  const purpose = !door.asked.includes(MERCHANT_FINDINGS.NO_PAYOUT_WALLET)
    ? `${settles} Publishing does not ask for this address here, so it is optional.`
    : door.missing.includes(MERCHANT_FINDINGS.NO_PAYOUT_WALLET)
      ? `${settles} Until you set one, publishing a card is refused.`
      : settles;

  return `
  <div class="panel-top">
  <div class="lede">
    <div>
      <h2>Payout wallet</h2>
      <p>${purpose} <a href="/docs/money#where-the-money-arrives">How and when you get paid</a>.</p>
      <p class="quiet">Enter only the public address. Never enter a private key or recovery phrase; Agentify will never ask for either. <a href="/docs/money#if-you-have-no-wallet-yet">No wallet yet?</a></p>
    </div>
  </div>${wallet === null ? "" : savedAddress(wallet)}${pending === undefined || pending === null ? "" : pendingAddress(base, wallet, pending)}${
    notice === undefined
      ? ""
      : `
  <p class="problem">${escaped(notice)}</p>`
  }
  <div class="lede">
    <div>
      <p class="quiet">${escaped(WALLET_RULE)}</p>${
        wallet !== null && viewer.mode === "live"
          ? `
      <p class="quiet">${escaped(LIVE_CHANGE_WAITS)}</p>`
          : ""
      }
    </div>
  </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/settings/payout-wallet">${
    pending === undefined || pending === null
      ? ""
      : `
    <input type="hidden" name="waiting" value="${escaped(pending.wallet)}">
    <input type="hidden" name="waiting_from" value="${escaped(pending.takesEffectAt)}">
    <input type="hidden" name="paid" value="${escaped(wallet ?? "")}">`
  }
    <div class="wallet-box">
      <label for="payout_wallet">${wallet === null ? "Payout wallet address" : "New payout wallet address"}</label>
      <input id="payout_wallet" name="payout_wallet" type="text" autocomplete="off" spellcheck="false" maxlength="42" size="42" value="${escaped(typed ?? "")}" required>
    </div>
    <button class="button button-primary" type="submit">${wallet === null ? "Save" : "Change the address"}</button>
  </form>
  <div class="panel-messages">
    ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
    ${problem === undefined || typed === undefined || typed === "" ? "" : `<p class="address">${inFours(typed)}</p>`}
  </div>
`;
};
