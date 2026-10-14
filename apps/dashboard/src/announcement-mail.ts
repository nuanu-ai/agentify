/**
 * The messages a merchant receives when the gateway reports a change to their
 * payout wallet or keys.
 *
 * None of them claims a person did it: a stolen session is signed in as the
 * owner all the same, and "you did this" would tell the owner to stand down on
 * the day they must not. A replacement wallet says "not before" the earliest
 * moment it can name, because the gateway's forty-eight hours start after every
 * message is handed over, and says the change happens only if Settings shows
 * it. A message carries a plain link to Settings and never a token or sign-in
 * link, so a forwarded or intercepted copy opens nothing. What a message
 * advises has to work in the state it describes: a waiting change can be
 * cancelled; when nothing waits, the advice is to stop selling, sign out every
 * other device, then set an address of one's own.
 */

import type { Announcement, AskedInTheDashboard, AskedWith } from "@agentify/gateway/announcements";
import { SIGN_OUT_EVERY_OTHER_DEVICE, STOP_ALL_SELLING } from "./control-labels.js";
import type { Message } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";
import { type CommissionRate, percentagesOf } from "./shares.js";
import { moment } from "./words.js";

export interface Screens {
  readonly wallet: string;
  readonly keys: string;
}

/**
 * A key's label was chosen by whoever holds the key, who may be the person the
 * message warns about. A zero-width space after every character a mail client
 * builds a link or an address from keeps it from becoming somewhere to click;
 * it is always quoted, beside the key's identifier.
 */
const inert = (label: string): string => label.replace(/[.:/@]/g, (mark) => `${mark}\u200B`);

const askedIn = (asked: AskedInTheDashboard): string =>
  `in the dashboard, from a session signed in as ${asked.email}`;

const askedBy = (asked: AskedWith): string =>
  asked.kind === "merchant_code"
    ? `with the key ${asked.id}, named "${inert(asked.label)}", one of the keys issued for your own code`
    : askedIn(asked);

const IF_NOT_YOU =
  "If nobody at your business did this, somebody else may be signed in to your dashboard: cancelling the change in the Payout wallet section of Settings signs every other session out.";

/**
 * The order matters: the stop is immediate; signing out every other device
 * keeps a session that is not the owner's from undoing what comes next; an
 * address of one's own waits and is announced.
 */
const PAUSE_THEN_SET = (settings: string): string =>
  `Somebody else may be signed in to your dashboard. First press ${STOP_ALL_SELLING} on the Cards screen, which stops new sales at once. Then press ${SIGN_OUT_EVERY_OTHER_DEVICE} in Settings, which ends every other session of your account: ${settings}. Then set your own address there; that waits forty-eight hours and is announced, so keep selling stopped until it applies.`;

/**
 * The split a wallet is paid through is checked by no eye, so the message is
 * the merchant's record of it: whole, and what it pays to whom.
 */
const paysOnly = (rate: CommissionRate, wallet: string): string => {
  const { commission, share } = percentagesOf(rate);
  return `It pays only ${wallet}, ${share} of every sale, and Agentify, ${commission}.`;
};

export function announcementMessage(
  to: string,
  announcement: Announcement,
  screens: Screens,
  rate: CommissionRate,
): Message {
  switch (announcement.kind) {
    case "wallet_change": {
      const notBefore = moment(announcement.not_before);
      const lead =
        `A change of the wallet your share of every sale is paid out to was asked for ${askedIn(announcement.asked_with)}.` +
        ` From ${announcement.from} to ${announcement.to}.`;
      const paragraphs = [
        `It takes effect not before ${notBefore}, and only if the Payout wallet section of your dashboard's Settings shows it waiting: ${screens.wallet}. Until then buyers pay into ${announcement.from_split}, the payout contract of ${announcement.from}.`,
        `From then on buyers pay into ${announcement.to_split}, the payout contract made for ${announcement.to}. ${paysOnly(rate, "that wallet")}`,
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
        `The wallet your share of every sale is paid out to was set to ${announcement.to} ${askedIn(announcement.asked_with)}.` +
        " It is the first address your merchant has had, so it applies now.";
      return written(to, {
        subject: "A payout wallet was set for your merchant",
        eyebrow: "Payout wallet",
        title: "A payout wallet was set",
        lead,
        action: "Open Settings",
        link: screens.wallet,
        paragraphs: [
          `Buyers now pay into ${announcement.to_split}, the payout contract made for this wallet. ${paysOnly(rate, "this wallet")}`,
          `If nobody at your business set it, act now. ${PAUSE_THEN_SET(screens.wallet)}`,
          "This message opens nothing by itself: sign in to your dashboard the usual way.",
        ],
      });
    }
    case "wallet_change_cancelled": {
      const lead =
        `The waiting change of your payout wallet to ${announcement.cancelled} was cancelled ${askedIn(announcement.asked_with)}.` +
        ` Your share of every sale is still paid out to ${announcement.kept}.`;
      return written(to, {
        subject: "A payout wallet change was cancelled",
        eyebrow: "Payout wallet",
        title: "A payout wallet change was cancelled",
        lead,
        action: "Open Settings",
        link: screens.wallet,
        paragraphs: [
          `Buyers still pay into ${announcement.kept_split}, the payout contract of ${announcement.kept}. ${paysOnly(rate, "that wallet")}`,
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
    // The URL stands on a line of its own, so a client that draws no button and
    // a person copying it by hand both get the whole of it.
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
