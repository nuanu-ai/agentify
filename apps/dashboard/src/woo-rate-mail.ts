/**
 * The message an account receives for every exchange rate saved for its
 * WooCommerce shop. A rate sets what every card of the shop costs, so a session
 * that is not the owner's could set one that sells the shop's goods for cents;
 * this message is how the owner learns of it. Like the payout wallet's, it
 * claims nobody did it, carries a plain link and no token, and says the rate
 * applies only where the screen shows it, since it is handed over before the
 * rate is written.
 */

import { SIGN_OUT_EVERY_OTHER_DEVICE, STOP_ALL_SELLING } from "./control-labels.js";
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
  /** The email of the session that saved it. */
  readonly setBy: string;
  /** The WooCommerce screen, where the rate is shown and set again. */
  readonly screen: string;
}

export function rateNoticeMessage(notice: RateNotice): Message {
  const lead =
    `A new exchange rate for your WooCommerce shop ${notice.shopOrigin} was saved in the` +
    ` dashboard at ${moment(notice.setAt.toISOString())}, from a session signed in as` +
    ` ${notice.setBy}: ${notice.rate} ${notice.currency} per US dollar.`;
  const paragraphs = [
    notice.previous === null
      ? "No rate was set before."
      : `The previous rate was ${notice.previous} ${notice.currency} per US dollar.`,
    `From now on buyers pay in US dollars at this rate, if the WooCommerce screen of your dashboard shows it: ${notice.screen}.`,
    `If nobody at your business did this, somebody else may be signed in to your dashboard. Press ${STOP_ALL_SELLING} on the Cards screen, which stops new sales at once, then ${SIGN_OUT_EVERY_OTHER_DEVICE} in Settings, then set your own rate again.`,
  ];
  return {
    to: notice.to,
    subject: `The exchange rate of your WooCommerce shop is now ${notice.rate} ${notice.currency} per US dollar`,
    body: [lead, ...paragraphs].join("\n\n"),
    html: transactionalEmailHtml({
      preview: lead,
      eyebrow: "WooCommerce",
      title: "A new exchange rate was saved",
      lead,
      action: "Open the WooCommerce screen",
      link: notice.screen,
      paragraphs,
      reason:
        "This message was sent because this address is the account of the dashboard where the rate was saved.",
    }),
  };
}
