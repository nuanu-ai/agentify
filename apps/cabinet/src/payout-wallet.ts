/**
 * The block on the settings screen where a merchant says which address their
 * money arrives at.
 *
 * Payments here are not held by anybody in the middle: a buyer's agent pays the
 * merchant's own address, and nothing of the merchant's ever sits with us. That
 * is the whole reason this field exists, and it is also why it is one field.
 * The address is enough to be paid with; a private key or a recovery phrase
 * would be enough to spend with, and there is nowhere in this cabinet to type
 * either. The screen says so out loud, because somebody who has been asked for
 * a recovery phrase once by a page that looked like this one has no other way
 * to tell the two apart.
 *
 * Two things on this screen are decisions rather than layout.
 *
 * The first is that a missing address gets no banner. The name a merchant is
 * listed under gets one on every screen, because a card published without a
 * name is refused everywhere, always. This one is not: where nothing settles,
 * publishing without an address is not refused, and a line saying "your
 * products cannot go on sale" would then be a page telling a merchant something
 * that is not happening. So the consequence is written once, here, in the form
 * that says which case is which.
 *
 * The second is how a saved address is shown back. It is shown whole, never
 * with the middle left out. Forty characters is more than anybody reads, and
 * the shortening everybody reaches for — the first few, dots, the last few — is
 * the one presentation under which a wrong address and the right one look
 * identical. So the whole of it is on the page, grouped in fours the way a
 * long number is, with no space actually in the text: a merchant reads it
 * against their wallet group by group, and a merchant who selects it gets the
 * address back rather than a spaced-out copy of it that pastes wrong.
 *
 * What is shown is whatever the gateway answered with, untouched. That is not
 * indifference about the spelling — it is where the spelling is decided. The
 * capitals in an address are a checksum over the address itself, the gateway
 * keeps every address in the mixed-case spelling a wallet displays, and it
 * answers in that spelling whichever of the two accepted spellings it was
 * given. So a merchant who pasted their address in lower case reads it back the
 * way their own wallet shows it, and this page never has to ask anybody to take
 * on trust that two spellings are one address.
 */

import { EvmAddressSchema } from "@nuanu-ai/agentify-contracts";

import { escaped, when } from "./html.js";
import type { Viewer } from "./screens.js";

/**
 * What an address has to look like, and the two things this page cannot tell
 * anybody about it.
 *
 * The rule itself is the contract's and is applied by asking the schema rather
 * than by writing the pattern out again here; what is written out is the
 * sentence, because a schema's message is one per broken rule and somebody
 * filling in a box is better served by the whole rule once.
 *
 * The second half is the part it would be easy to leave off. Nothing in the
 * cabinet looks an address up anywhere — there is no chain call on this path
 * and no balance read — so a box that turned green would be promising something
 * nobody checked. Said plainly, a merchant knows the check they still have to
 * do themselves is the only one there is.
 */
export const WALLET_RULE =
  "Paste an EVM address: 0x followed by 40 hexadecimal characters. Use the mixed-case spelling" +
  " from your wallet or all lower case. This checks its shape and checksum, not the network or" +
  " who owns it, so copy it from your wallet rather than typing it.";

/**
 * What a merchant on the live deployment is told before replacing an address,
 * so a change that does not apply at once is not read as one that failed.
 */
export const LIVE_CHANGE_WAITS =
  "A different address takes effect forty-eight hours after every account of your merchant" +
  " is sent a message about it. Until then your sales are paid into the address above.";

/** What somebody who pressed the button with an empty box is told. */
export const WALLET_NEEDED =
  "An address is needed here. Copy it out of the wallet you want to be paid in rather than" +
  " typing it, and paste the whole of it.";

/**
 * The half of a refusal this file writes, and the half a merchant cannot see.
 *
 * They can see the box still holding what they typed. Whether it went anywhere
 * is the thing they cannot, and on this one field that is the difference
 * between money arriving where they meant it and money arriving somewhere else.
 */
const NOTHING_WAS_SAVED = "It was not saved.";

/**
 * What is wrong with an address somebody typed, in a sentence, or null.
 *
 * The sentence is the rule's own, asked of the schema rather than written out
 * here a second time. Two rules can fail and they fail differently: forty
 * characters that are not an address at all, and forty of the right shape whose
 * capitals disagree with the rest — which means a character in it is wrong, and
 * is the failure this box exists to catch at all. One sentence covering both
 * would have to say "that is not an address", which is untrue of the second and
 * leaves a merchant re-reading a spelling that looks perfectly fine.
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
 * What the merchant's payout address is on the screen drawing it.
 *
 * The refusal travels with the address rather than beside it because one block
 * draws both, and a screen holding one without the other cannot draw that
 * block at all.
 */
export interface PayoutWallet {
  /** What the gateway answered: the address, or null where none is set. */
  readonly wallet: string | null;
  /**
   * A replacement announced and waiting on the live deployment, and when it
   * takes effect, as the gateway answered them (ADR-0019). Absent or null
   * where nothing waits.
   */
  readonly pending?: { readonly wallet: string; readonly takesEffectAt: string } | null;
  /** What was wrong with the address just typed, where one was refused. */
  readonly problem?: string;
  /** What was refused, so the merchant can correct it rather than retype it. */
  readonly typed?: string;
}

/**
 * One address, whole, in groups of four.
 *
 * The groups are spans with nothing between them, so the gaps are the
 * stylesheet's and not the text's. That is the difference between a merchant
 * who copies this and pastes an address and a merchant who copies this and
 * pastes something no wallet will accept.
 */
const inFours = (address: string): string => {
  const lead = address.slice(0, 2);
  const rest = address.slice(2);
  const groups = rest.match(/.{1,4}/g) ?? [];
  return `<span class="lead">${escaped(lead)}</span>${groups
    .map((group) => `<span class="quad">${escaped(group)}</span>`)
    .join("")}`;
};

/** The address as it stands, with what to do with it before trusting it. */
const savedAddress = (address: string): string => `
  <div class="saved">
    <div class="label">Saved here</div>
    <div class="address">${inFours(address)}</div>
    <p class="under">This is the spelling your own wallet shows, so read it against your wallet group by group. Two addresses that differ only in the middle look the same when the middle is left out, so the whole of it is here.</p>
  </div>`;

/**
 * A replacement that waits, whole and in fours like the address it replaces,
 * with the moment it takes effect and the one control that stops it.
 *
 * It is on this screen because the message about it says the change takes
 * effect only if this screen shows it (ADR-0019), and that sentence is only
 * true if the screen always does. The cancel is a form post from this page and
 * nothing else — a link could be sent from anywhere — and it says what else it
 * does, because ending every other session is not something a person expects
 * from a button about an address.
 */
const pendingAddress = (base: string, pending: NonNullable<PayoutWallet["pending"]>): string => `
  <div class="saved">
    <div class="label">Waiting to replace it</div>
    <div class="address">${inFours(pending.wallet)}</div>
    <p class="under">From ${when(pending.takesEffectAt)} your sales are paid into this address instead. Every account of your merchant was sent a message about it. If nobody at your business asked for it, cancel it; cancelling also signs out every session of your merchant but this one.</p>
    <form class="inline" method="post" action="${escaped(base)}/settings/payout-wallet/cancel">
      <button class="button button-secondary" type="submit">Cancel this change</button>
    </form>
  </div>`;

/**
 * The block itself.
 *
 * It draws nothing at all where the screen did not ask the gateway for the
 * address, which is every screen but the settings. That is the same rule the
 * line about an unset name follows: a page that did not ask must not say
 * anything either way, and a block drawn from an address nobody fetched would
 * be a page telling a merchant they have set none when they may have.
 *
 * The box beside a saved address starts empty rather than filled with it. An
 * input reads as a draft, and the thing a merchant came here to do — check what
 * is actually stored — is not something a box you can type over can show them.
 * So the stored address is text, the box is for a different one, and the label
 * on it says which of the two acts this is.
 *
 * A refused address is handed back the same way, whole and in fours under the
 * sentence that refused it. The box keeps it too, so it can be corrected rather
 * than retyped, but a box shows only as much of an address as it is wide — on
 * a phone about two thirds — and the refusal for capitals that disagree asks
 * the merchant to find one wrong character in the whole of it.
 */
export const payoutWalletBlock = (viewer: Viewer): string => {
  const { base, payout } = viewer;
  if (payout === undefined) {
    return "";
  }
  const { wallet, pending, problem, typed } = payout;
  const purpose =
    viewer.mode === "test"
      ? "TEST settles test USDC on Base Sepolia to this address."
      : viewer.mode === "live"
        ? "LIVE settles real USDC on Base mainnet to this address."
        : "SANDBOX does not settle a payment, so this address is optional here.";

  return `
  <div class="lede">
    <div>
      <h2>Where your money arrives</h2>
      <p>${purpose} <a href="/docs/money#where-the-money-arrives">Where the money arrives, and when</a>.</p>
      <p class="quiet">Enter only the public address. Never enter a private key or recovery phrase; Agentify will never ask for either.</p>
    </div>
  </div>${wallet === null ? "" : savedAddress(wallet)}${pending === undefined || pending === null ? "" : pendingAddress(base, pending)}
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
  <form class="issue" method="post" action="${escaped(base)}/settings/payout-wallet">
    <div>
      <label for="payout_wallet">${wallet === null ? "The address your money arrives at" : "Change it to a different address"}</label>
      <input id="payout_wallet" name="payout_wallet" type="text" autocomplete="off" spellcheck="false" maxlength="42" size="42" value="${escaped(typed ?? "")}" required>
    </div>
    <button class="button button-primary" type="submit">${wallet === null ? "Save it" : "Change the address"}</button>
    ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
    ${problem === undefined || typed === undefined || typed === "" ? "" : `<p class="address">${inFours(typed)}</p>`}
  </form>
`;
};
