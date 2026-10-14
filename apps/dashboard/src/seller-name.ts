/**
 * The rules the name buyers read beside every product and the shop's site are
 * held to, in words, wherever they are set; the screens that set them are drawn
 * by React Router (`app/screens/setup.tsx`, `app/screens/settings.tsx`).
 */

import { SellerSiteSchema, ServiceNameSchema } from "@nuanu-ai/agentify-contracts";
import { STOP_ALL_SELLING } from "./control-labels.js";

/**
 * The rule itself is the contract's `ServiceNameSchema`, the discovery
 * catalogue's own rule, and is applied by asking it; only the sentence is
 * written out, because the schema reports one message per broken rule.
 */
export const NAME_RULE =
  "Use 1 to 32 characters of printable ASCII: Latin letters, numbers, spaces or common punctuation," +
  " as plain text, without HTML tags or codes such as &amp;. Spaces at either end are removed.";

/**
 * The rule whole, then what the person cannot see: that nothing was written.
 * The name is checked here as well as at the gateway so the person reads this
 * rather than the gateway's refusal, which names a route rather than a page.
 */
export const NAME_REFUSED =
  "Use 1 to 32 characters of printable ASCII (Latin letters, numbers, spaces or common punctuation)" +
  " as plain text, without HTML tags or codes such as &amp;. Your name was not saved.";

export const NAME_NEEDED =
  "A name is needed here. If you have not settled on one yet, leave this for now with the link" +
  " below and come back to it in your settings.";

/**
 * Emptying the name is refused by rule: a card on sale with nobody named beside
 * it reaches a buyer as a request to pay somebody it does not name. Coming off
 * sale is the control that does what somebody emptying the box wants.
 */
export const NAME_CANNOT_BE_TAKEN_AWAY =
  `The seller name cannot be empty once you have an account. To stop selling, use ${STOP_ALL_SELLING}` +
  " on the Cards screen; your cards stay there until you resume.";

export const whatIsWrongWithTheName = (name: string): string | null =>
  ServiceNameSchema.safeParse(name).success ? null : NAME_REFUSED;

/**
 * The form is the contract's `SellerSiteSchema`, applied by asking it. The
 * sentence says what agents do with the address and that nobody checks it,
 * because a merchant would otherwise assume both the other way.
 */
export const SITE_RULE =
  "The address of your shop's own website: https:// and your domain, with nothing after it," +
  " such as https://yourshop.com. Agents read it beside your seller name on every card and order," +
  " as where to go with what an order cannot answer — goods that did not arrive, a return, your" +
  " terms. Agentify does not check it.";

const SITE_REFUSED =
  "Write the address as https:// and your shop's domain name, with nothing after it:" +
  " https://yourshop.com, in lower case, with no page, query, port or slash at the end." +
  " Your site was not saved.";

/**
 * Refused for the reason the gateway refuses it: an agent holding an order that
 * named the site has been told where to go, and a vanished site would leave it
 * nowhere.
 */
export const SITE_CANNOT_BE_TAKEN_AWAY =
  "A site cannot be removed once given, only changed: type the address your shop has moved to.";

export const whatIsWrongWithTheSite = (site: string): string | null =>
  SellerSiteSchema.safeParse(site).success ? null : SITE_REFUSED;
