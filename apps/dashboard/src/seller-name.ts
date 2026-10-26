/**
 * The rules the name buyers read beside every product and the shop's site are
 * held to, in words, wherever they are set; the screens that set them are drawn
 * by React Router (`app/screens/setup.tsx`, `app/screens/settings.tsx`).
 */

import { SellerSiteSchema, ServiceNameSchema } from "@nuanu-ai/agentify-contracts";
import { STOP_ALL_SELLING } from "./control-labels.js";

/**
 * The rule itself is the contract's `ServiceNameSchema`, which holds the name to
 * what the payment network's public listing of sellers carries, and is applied
 * by asking it; only the sentence is written out, because the schema reports
 * one message per broken rule. Spaces at either end are trimmed before the
 * rule is asked, so the sentence does not mention them.
 */
export const NAME_RULE =
  "The payment network allows up to 32 characters: letters A to Z, numbers, spaces and punctuation.";

/**
 * The rule whole, then what the person cannot see: that nothing was written.
 * The name is checked here as well as at the gateway so the person reads this
 * rather than the gateway's refusal, which names a route rather than a page.
 */
export const NAME_REFUSED =
  "The payment network allows only letters A to Z, numbers, spaces and punctuation, up to 32" +
  " characters. Your name was not saved.";

/**
 * Plain text is Agentify's own rule rather than the network's, so its refusal
 * does not lend it the network's name.
 */
const NAME_NOT_PLAIN =
  "Write the name as plain text, without HTML tags or codes such as &amp;. Your name was not saved.";

export const NAME_NEEDED = "Enter a name, or choose one later.";

/**
 * Emptying the name is refused by rule: a card on sale with nobody named beside
 * it reaches a buyer as a request to pay somebody it does not name. Coming off
 * sale is the control that does what somebody emptying the box wants.
 */
export const NAME_CANNOT_BE_TAKEN_AWAY = `A seller name can't be removed, only changed. To stop selling, use ${STOP_ALL_SELLING} on Products.`;

/**
 * The listing's own limits are checks of length and character; what is left
 * over is the plain-text rule, the one refinement the schema adds of its own.
 */
export const whatIsWrongWithTheName = (name: string): string | null => {
  const checked = ServiceNameSchema.safeParse(name);
  if (checked.success) return null;
  return checked.error.issues.every((issue) => issue.code === "custom")
    ? NAME_NOT_PLAIN
    : NAME_REFUSED;
};

/**
 * The form is the contract's `SellerSiteSchema`, applied by asking it. It
 * says that nobody checks the address, because a merchant would otherwise
 * assume we do.
 */
export const SITE_RULE =
  "https:// and your domain only, such as https://yourshop.com. We don't check it.";

const SITE_REFUSED =
  "Use https:// and your domain only, such as https://yourshop.com, with nothing after it." +
  " Your site was not saved.";

/**
 * The same address cut to what the rule takes, where cutting it gives one:
 * what a person meant who pasted a page of their shop.
 */
const domainOf = (site: string): string | null => {
  let read: URL;
  try {
    read = new URL(site.includes("://") ? site : `https://${site}`);
  } catch {
    return null;
  }
  const domain = `https://${read.hostname.toLowerCase()}`;
  return SellerSiteSchema.safeParse(domain).success ? domain : null;
};

/**
 * Refused for the reason the gateway refuses it: an agent holding an order that
 * named the site has been told where to go, and a vanished site would leave it
 * nowhere.
 */
export const SITE_CANNOT_BE_TAKEN_AWAY =
  "A site can't be removed, only changed. Enter the address your shop has moved to.";

export const whatIsWrongWithTheSite = (site: string): string | null => {
  if (SellerSiteSchema.safeParse(site).success) return null;
  const domain = domainOf(site);
  return domain === null
    ? SITE_REFUSED
    : `Use the domain only: ${domain}. Your site was not saved.`;
};

/**
 * The characters a refused name holds that the listing cannot carry, each
 * named once in the order typed, so the person sees which to change.
 */
const outsideTheListing = (name: string): string[] => [
  ...new Set(name.match(/[^\x20-\x7e]/gu) ?? []),
];

/** A refusal of `typed`, led by the characters in it that cannot be used, where there are any. */
export const nameRefusedSaying = (typed: string, problem: string): string => {
  const culprits = outsideTheListing(typed);
  return culprits.length === 0
    ? problem
    : `${culprits.map((one) => `“${one}”`).join(", ")} can't be used. ${problem}`;
};
