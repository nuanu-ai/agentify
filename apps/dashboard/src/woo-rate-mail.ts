/**
 * The message an account receives for every exchange rate saved for its
 * WooCommerce shop. A rate sets what every card of the shop costs, so a session
 * that is not the owner's could set one that sells the shop's goods for cents;
 * this message is how the owner learns of it. Like the payout wallet's, it
 * claims nobody did it, carries a plain link and no token, and says the rate
 * applies only where the screen shows it, since it is handed over before the
 * rate is written. It goes to the account's own address, which every session
 * of the account is signed in as, so it tells the saving session apart by when
 * that session signed in instead.
 */

import { SIGN_OUT_EVERYWHERE, STOP_ALL_SELLING } from "./control-labels.js";
import type { Message } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";
import { moment } from "./words.js";

export interface RateNotice {
  readonly to: string;
  readonly shopOrigin: string;
  readonly currency: string;
  readonly rate: string;
  readonly previous: string | null;
  readonly setAt: Date;
  /** When the session that saved it signed in; null where it could not be read. */
  readonly sessionSignedInAt: Date | null;
  /** The WooCommerce screen, where the rate is shown and set again. */
  readonly screen: string;
}

export function rateNoticeMessage(notice: RateNotice): Message {
  const lead =
    `A new exchange rate for your WooCommerce shop ${notice.shopOrigin} was entered in the` +
    ` dashboard at ${moment(notice.setAt.toISOString())}: ${notice.rate} ${notice.currency} per US dollar.`;
  const signedIn =
    notice.sessionSignedInAt === null ? null : moment(notice.sessionSignedInAt.toISOString());
  const paragraphs = [
    signedIn === null
      ? "It was entered from a session signed in to this account."
      : `It was entered from a session that signed in to this account at ${signedIn}. A session copied from a browser of yours would show that browser's own sign-in, so a moment you recognise does not prove it was you.`,
    notice.previous === null
      ? "No rate was set before."
      : `The previous rate was ${notice.previous} ${notice.currency} per US dollar.`,
    `Buyers pay in US dollars at this rate once it is saved, which the WooCommerce screen of your dashboard shows: ${notice.screen}.`,
    `If nobody at your business entered this rate${signedIn === null ? "" : `, or nobody signed in at ${signedIn}`}, somebody else may be signed in to your dashboard. Press ${STOP_ALL_SELLING} on the Cards screen, which stops new sales at once, then ${SIGN_OUT_EVERYWHERE} in Settings, which ends every session of your account, the one you press it from included. Then sign in again with a new link and set your own rate again.`,
  ];
  return {
    to: notice.to,
    subject: `A new exchange rate for your WooCommerce shop: ${notice.rate} ${notice.currency} per US dollar`,
    body: [lead, ...paragraphs].join("\n\n"),
    html: transactionalEmailHtml({
      preview: lead,
      eyebrow: "WooCommerce",
      title: "A new exchange rate was entered",
      lead,
      action: "Open the WooCommerce screen",
      link: notice.screen,
      paragraphs,
      reason:
        "This message was sent because this address is the account of the dashboard where the rate was saved.",
    }),
  };
}
