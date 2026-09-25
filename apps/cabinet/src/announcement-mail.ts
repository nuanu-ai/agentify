/**
 * The messages the cabinet sends when the gateway asks it to tell a merchant
 * of a change (ADR-0019).
 *
 * Four kinds, all about something done with one of the merchant's keys: a
 * first payout wallet set, a replacement that is waiting, a waiting change
 * that was cancelled, and a new key for the merchant's own code. Each says what
 * happened, which key it was done with, and where in the cabinet to look. The
 * one the rest exist around is the first, and it has three things to get
 * right.
 *
 * When. The gateway counts the forty-eight hours from the moment every message
 * was handed over, which is after this one is written, so the message cannot
 * know the exact moment. It says "not before" the moment it can name, which is
 * true of every message sent, and the wallet screen shows the exact one.
 *
 * What decides it. A message about a change the gateway then refused to record
 * is possible and safe, but only if the message says the change happens only
 * if the wallet screen shows it — so it says that, and says what to do if the
 * reader did not ask for it.
 *
 * What it carries. A plain link to the wallet screen and nothing that opens
 * anything: no token, no sign-in link. A person who is signed out signs in the
 * ordinary way and lands on that screen. A message that could open a session
 * would turn every forwarded or intercepted copy of it into a way into the
 * merchant's cabinet, on the one day somebody is trying to move their money.
 *
 * A key is named the way the merchant's list of keys names it: its label, with
 * its identifier beside it, so the row can be found and disabled. The key the
 * cabinet signs in with is on no list, and a call made with it means a person
 * signed in to the cabinet acted, so it is named as that.
 */

import type { Announcement, AskedWith } from "@agentify/gateway/announcements";
import type { Message } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";
import { moment } from "./words.js";

/** Where the screens a message points at are, from the reader's machine. */
export interface Screens {
  /** The settings screen, which carries the payout wallet and its cancel control. */
  readonly wallet: string;
  /** The screen the merchant's own keys are listed and disabled on. */
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

/** A key, the way a person reading the message finds it in the cabinet. */
const named = (key: AskedWith): string =>
  key.kind === "cabinet"
    ? "the cabinet, by a person signed in to it"
    : `the key ${key.id}, named "${inert(key.label)}", one of the keys issued for your own code`;

/** What to do about it, if the reader did not ask for it. */
const ifNotYou = (key: AskedWith): string =>
  key.kind === "cabinet"
    ? "If nobody at your business did this, somebody else may be signed in to your cabinet: cancelling a waiting wallet change on the wallet screen signs every other session out."
    : `If nobody at your business did this, disable the key ${key.id} on the keys screen of your cabinet.`;

export function announcementMessage(
  to: string,
  announcement: Announcement,
  screens: Screens,
): Message {
  switch (announcement.kind) {
    case "wallet_change": {
      const notBefore = moment(announcement.not_before);
      const lead =
        `A change of the wallet your sales are paid into was asked for with ${named(announcement.asked_with)}.` +
        ` From ${announcement.from} to ${announcement.to}.`;
      const paragraphs = [
        `It takes effect not before ${notBefore}, and only if the wallet screen of your cabinet shows it waiting: ${screens.wallet}. Until then every sale is paid into ${announcement.from}.`,
        `If you did not ask for this, cancel it on that screen. ${ifNotYou(announcement.asked_with)}`,
        "This message opens nothing by itself: sign in to your cabinet the usual way.",
      ];
      return written(to, {
        subject: "Your payout wallet is set to change",
        eyebrow: "Payout wallet",
        title: "Your payout wallet is set to change",
        lead,
        action: "Open the wallet screen",
        link: screens.wallet,
        paragraphs,
      });
    }
    case "wallet_set": {
      const lead =
        `The wallet your sales are paid into was set to ${announcement.to}, with ${named(announcement.asked_with)}.` +
        " It is the first address your merchant has had, so it applies now.";
      return written(to, {
        subject: "A payout wallet was set for your merchant",
        eyebrow: "Payout wallet",
        title: "A payout wallet was set",
        lead,
        action: "Open the wallet screen",
        link: screens.wallet,
        paragraphs: [
          `If nobody at your business set it, stop selling from your cabinet and set your own address on the wallet screen: ${screens.wallet}. A replacement waits forty-eight hours and is announced. ${ifNotYou(announcement.asked_with)}`,
          "This message opens nothing by itself: sign in to your cabinet the usual way.",
        ],
      });
    }
    case "wallet_change_cancelled": {
      const lead =
        `The waiting change of your payout wallet to ${announcement.cancelled} was cancelled with ${named(announcement.asked_with)}.` +
        ` Your sales are still paid into ${announcement.kept}.`;
      return written(to, {
        subject: "A payout wallet change was cancelled",
        eyebrow: "Payout wallet",
        title: "A payout wallet change was cancelled",
        lead,
        action: "Open the wallet screen",
        link: screens.wallet,
        paragraphs: [
          `If you did not cancel it, ask for the change again on that screen. ${ifNotYou(announcement.asked_with)}`,
          "This message opens nothing by itself: sign in to your cabinet the usual way.",
        ],
      });
    }
    case "key_issued": {
      const lead =
        `A new key, ${announcement.key.id}, named "${inert(announcement.key.label)}", was issued for your own code with ${named(announcement.asked_with)}.` +
        " A key can call everything your code can, including a change of your payout wallet, which is announced and waits.";
      return written(to, {
        subject: "A new key was issued for your merchant",
        eyebrow: "Keys",
        title: "A new key was issued",
        lead,
        action: "Open the keys screen",
        link: screens.keys,
        paragraphs: [
          `If nobody at your business issued it, disable it on the keys screen: ${screens.keys}.`,
          "This message opens nothing by itself: sign in to your cabinet the usual way.",
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
      reason: "This message was sent to every cabinet account of your merchant.",
    }),
  };
}
