/**
 * The messages the dashboard sends when the gateway asks it to tell a merchant
 * of a change (ADR-0019).
 *
 * Four kinds: a first payout wallet set, a replacement that is waiting, a
 * waiting change that was cancelled, and a new key for the merchant's own
 * code. Each says what happened, who asked, and where in the dashboard to
 * look. Who asked is what the gateway knows of the call: the account a
 * dashboard session was signed in as, which is how a wallet is changed
 * (ADR-0019) and a key is usually issued, or the key a call over the API was
 * made with. None of them claims a person, because a session somebody else
 * took is signed in as the owner all the same, and a message that said "you
 * did this" would tell the owner to stand down on the one day they must not.
 * The one the rest exist around is the replacement, and it has three things to
 * get right.
 *
 * When. The gateway counts the forty-eight hours from the moment every message
 * was handed over, which is after this one is written, so the message cannot
 * know the exact moment. It says "not before" the moment it can name, which is
 * true of every message sent, and the wallet section of Settings shows the
 * exact one.
 *
 * What decides it. A message about a change the gateway then refused to record
 * is possible and safe, but only if the message says the change happens only
 * if the wallet section of Settings shows it — so it says that, and says what
 * to do if the reader did not ask for it.
 *
 * What it carries. A plain link to Settings and nothing that opens anything:
 * no token, no sign-in link. A person who is signed out signs in the
 * ordinary way and lands on that screen. A message that could open a session
 * would turn every forwarded or intercepted copy of it into a way into the
 * merchant's dashboard, on the one day somebody is trying to move their money.
 *
 * A key that issued a new one is named the way the merchant's list of keys
 * names it: its label, with its identifier beside it, so the row can be found
 * and revoked.
 *
 * What a message advises has to work in the state it describes. A waiting
 * change can be cancelled, and the cancel signs every other session out. After
 * a first wallet or a cancel nothing waits, so what works is stopping the
 * selling at once, signing out every other device, and then setting an
 * address, which waits and is announced. The two controls are named from
 * `control-labels.ts`, the file the screens draw them from.
 */

import type { Announcement, AskedInTheDashboard, AskedWith } from "@agentify/gateway/announcements";
import { SIGN_OUT_EVERY_OTHER_DEVICE, STOP_ALL_SELLING } from "./control-labels.js";
import type { Message } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";
import { moment } from "./words.js";

/** Where the screens a message points at are, from the reader's machine. */
export interface Screens {
  /** The settings screen, which carries the payout wallet and its cancel control. */
  readonly wallet: string;
  /** The screen the merchant's own keys are listed and revoked on. */
  readonly keys: string;
}

/**
 * A key's label as data rather than as words of ours.
 *
 * Somebody holding one of the merchant's keys chose it, and that somebody may
 * be the person the message is warning about. It arrives on one line; here a
 * zero-width space goes after every character a mail client builds a link or
 * an address out of, so "confirm at https://…" in a label is shown as the
 * characters it is and never becomes somewhere to click. It is always quoted,
 * and always beside the key's identifier, which is what finds the key.
 */
const inert = (label: string): string => label.replace(/[.:/@]/g, (mark) => `${mark}\u200B`);

/**
 * Who asked for something the wallet section of Settings does, as a phrase that
 * follows "was asked for" or "was set".
 */
const askedIn = (asked: AskedInTheDashboard): string =>
  `in the dashboard, from a session signed in as ${asked.email}`;

/** Who asked for a new key: as above, or a key the reader finds on their list. */
const askedBy = (asked: AskedWith): string =>
  asked.kind === "merchant_code"
    ? `with the key ${asked.id}, named "${inert(asked.label)}", one of the keys issued for your own code`
    : askedIn(asked);

/** What to do about a waiting change, if the reader did not ask for it. */
const IF_NOT_YOU =
  "If nobody at your business did this, somebody else may be signed in to your dashboard: cancelling the change in the Payout wallet section of Settings signs every other session out.";

/**
 * What works when nothing waits, in the order it works: the stop, which is
 * immediate; the sign-out of every other device, so a session that is not the
 * owner's cannot undo what comes next; and an address of one's own, which
 * waits and is announced. The two controls are named as the screens name them.
 */
const PAUSE_THEN_SET = (settings: string): string =>
  `Somebody else may be signed in to your dashboard. First press ${STOP_ALL_SELLING} on the Cards screen, which stops new sales at once. Then press ${SIGN_OUT_EVERY_OTHER_DEVICE} in Settings, which ends every other session of your account: ${settings}. Then set your own address there; that waits forty-eight hours and is announced, so keep selling stopped until it applies.`;

export function announcementMessage(
  to: string,
  announcement: Announcement,
  screens: Screens,
): Message {
  switch (announcement.kind) {
    case "wallet_change": {
      const notBefore = moment(announcement.not_before);
      const lead =
        `A change of the wallet your sales are paid into was asked for ${askedIn(announcement.asked_with)}.` +
        ` From ${announcement.from} to ${announcement.to}.`;
      const paragraphs = [
        `It takes effect not before ${notBefore}, and only if the Payout wallet section of your dashboard's Settings shows it waiting: ${screens.wallet}. Until then every sale is paid into ${announcement.from}.`,
        `If you did not ask for this, cancel it there. ${IF_NOT_YOU}`,
        "This message opens nothing by itself: sign in to your dashboard the usual way.",
      ];
      return written(to, {
        subject: "Your payout wallet is set to change",
        eyebrow: "Payout wallet",
        title: "Your payout wallet is set to change",
        lead,
        action: "Open Settings",
        link: screens.wallet,
        paragraphs,
      });
    }
    case "wallet_set": {
      const lead =
        `The wallet your sales are paid into was set to ${announcement.to} ${askedIn(announcement.asked_with)}.` +
        " It is the first address your merchant has had, so it applies now.";
      return written(to, {
        subject: "A payout wallet was set for your merchant",
        eyebrow: "Payout wallet",
        title: "A payout wallet was set",
        lead,
        action: "Open Settings",
        link: screens.wallet,
        paragraphs: [
          `If nobody at your business set it, act now. ${PAUSE_THEN_SET(screens.wallet)}`,
          "This message opens nothing by itself: sign in to your dashboard the usual way.",
        ],
      });
    }
    case "wallet_change_cancelled": {
      const lead =
        `The waiting change of your payout wallet to ${announcement.cancelled} was cancelled ${askedIn(announcement.asked_with)}.` +
        ` Your sales are still paid into ${announcement.kept}.`;
      return written(to, {
        subject: "A payout wallet change was cancelled",
        eyebrow: "Payout wallet",
        title: "A payout wallet change was cancelled",
        lead,
        action: "Open Settings",
        link: screens.wallet,
        paragraphs: [
          `If you did not cancel it, the cancel may have signed you out too, with every other session of your merchant, so sign in again. ${PAUSE_THEN_SET(screens.wallet)}`,
          "This message opens nothing by itself: sign in to your dashboard the usual way.",
        ],
      });
    }
    case "key_issued": {
      const lead =
        `A new key, ${announcement.key.id}, named "${inert(announcement.key.label)}", was issued for your own code ${askedBy(announcement.asked_with)}.` +
        " A key can call everything your code can, except changing where your money goes, which only the dashboard does.";
      return written(to, {
        subject: "A new key was issued for your merchant",
        eyebrow: "Keys",
        title: "A new key was issued",
        lead,
        action: "Open API keys",
        link: screens.keys,
        paragraphs: [
          `If nobody at your business issued it, revoke it on the API keys screen: ${screens.keys}.`,
          "This message opens nothing by itself: sign in to your dashboard the usual way.",
        ],
      });
    }
    default: {
      const unwritten: never = announcement;
      throw new Error(`there is no message for ${JSON.stringify(unwritten)}`);
    }
  }
}

function written(
  to: string,
  content: {
    readonly subject: string;
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly action: string;
    readonly link: string;
    readonly paragraphs: readonly string[];
  },
): Message {
  return {
    to,
    subject: content.subject,
    // The URL stands on a line of its own, so that a client that draws no
    // button and a person copying it by hand both get the whole of it.
    body: `Agentify\n\n${content.title}\n\n${content.lead}\n\n${content.paragraphs.join("\n\n")}\n\n${content.action}:\n\n${content.link}`,
    html: transactionalEmailHtml({
      preview: content.lead,
      eyebrow: content.eyebrow,
      title: content.title,
      lead: content.lead,
      action: content.action,
      link: content.link,
      paragraphs: content.paragraphs,
      reason: "This message was sent to everybody who signs in to your merchant's dashboard.",
    }),
  };
}
