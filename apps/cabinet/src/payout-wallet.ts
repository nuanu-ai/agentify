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
 * that is not happening. So the mode line under the box says which case is
 * which, in a clause.
 *
 * The second is how a saved address is shown back. It is shown whole, never
 * with the middle left out. Forty characters is more than anybody reads, and
 * the shortening everybody reaches for — the first few, dots, the last few — is
 * the one presentation under which a wrong address and the right one look
 * identical. So the whole of it is on the page, grouped in fours the way a
 * long number is, with no space actually in the text: a merchant reads it
 * against their wallet group by group, and a merchant who selects it gets the
 * address back rather than a spaced-out copy of it that pastes wrong. Why it
 * is whole used to be a paragraph beside it; it is now the layout doing the
 * arguing, and the one sentence kept is the one the layout cannot say.
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

import { escaped } from "./html.js";
import type { Viewer } from "./screens.js";

/**
 * The one line under the box, which has to carry two facts in thirteen words.
 *
 * What to paste, and what must never be pasted. The second is not caution for
 * its own sake: somebody who has been asked for a recovery phrase once by a
 * page that looked like this one has no other way to tell the two apart, and
 * this is the only sentence on the screen that tells them.
 *
 * What is not here any more is the shape of the address written out in prose.
 * The box holds it — `pattern`, `maxlength` and a `title` the browser shows on
 * a refusal — and the refusal says which rule broke. Nor is "copy it from your
 * wallet rather than typing it" here: it is advice, and a merchant who typed
 * one out meets the checksum refusal, which is the sentence that actually
 * helps.
 */
export const WALLET_RULE = "A public EVM address, 0x and 40 hex characters. Never a private key.";

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

/**
 * The address as it stands, with the one thing about it nobody checked.
 *
 * The clause is the fifth gate on this field. The schema read the shape and
 * the capitals, which catches a character typed wrong; nothing here asked a
 * chain whose address this is, and a merchant who reads "saved" over an
 * address takes that for more than it is.
 */
const savedAddress = (address: string): string => `
  <div class="saved">
    <div class="label">Saved here</div>
    <div class="address">${inFours(address)}</div>
    <p class="under">Shape and checksum checked; ownership is not.</p>
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
 */
export const payoutWalletBlock = (viewer: Viewer): string => {
  const { base, payout } = viewer;
  if (payout === undefined) {
    return "";
  }
  const { wallet, problem, typed } = payout;
  // Which chain and which token, in a clause, because a merchant reading
  // "payout address" on three stacks is looking at three different promises —
  // and on one of them at no promise at all.
  const arrives =
    viewer.mode === "test"
      ? " Test payments arrive here in USDC on Base Sepolia."
      : viewer.mode === "live"
        ? " Live payments arrive here in USDC on Base."
        : " Sandbox settles no payment, so this is optional here.";

  return `
  <div class="lede">
    <div>
      <h2>Payout address</h2>
    </div>
  </div>${wallet === null ? "" : savedAddress(wallet)}
  <form class="issue" method="post" action="${escaped(base)}/settings/payout-wallet">
    <div>
      <label for="payout_wallet">${wallet === null ? "Where your money arrives" : "Change it to a different address"}</label>
      <input id="payout_wallet" name="payout_wallet" type="text" autocomplete="off" spellcheck="false" maxlength="42" size="42" value="${escaped(typed ?? "")}" required>
      ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
      <p class="quiet">${escaped(`${WALLET_RULE}${arrives}`)} <a href="/docs/money#where-the-money-arrives">Learn more</a>.</p>
    </div>
    <button class="button button-compact button-primary" type="submit">${wallet === null ? "Save" : "Change the address"}</button>
  </form>
`;
};
