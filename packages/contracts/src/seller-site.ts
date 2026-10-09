/**
 * The address of a seller's own shop, held where both the card that names it
 * and a parcel's tracking page, whose host is held to the same rule, can read
 * it (ADR-0033, ADR-0034).
 */

import { z } from "zod";

/** What a seller's site is held to, said once for the refusal and the description. */
const SITE_FORM =
  "a seller's site is https:// and the domain name of their shop, with nothing after it — https://shop.example: in lower case, a domain name rather than an IP address or a single word, with no path, query, fragment, port, credentials or trailing slash";

/**
 * The address of a seller's own shop on the web, where an agent takes what an
 * order cannot answer (ADR-0034).
 *
 * Only an https origin, because anything after the host — a path, a query, a
 * fragment — would be text of the merchant's own reaching every agent that
 * reads the card, which is the free text the decision refuses. The host is the
 * one part the merchant writes, so it is held to a domain name too: labels of
 * letters, digits and hyphens, at most 253 characters, ending in a zone of
 * letters or a punycode one. Anything a URL parser keeps as written would
 * otherwise pass — a sentence of instructions, a quote, a host of any length —
 * and so would a single word or an IP address, which point other people's
 * agents into somebody's own network. What the pattern cannot do is tell a
 * public name from a private one: a name in a zone kept for local networks,
 * or a public one whose address leads into one, passes, and so does a
 * hyphenated sentence of up to 253 characters that is a valid name. That is
 * why an agent is told, beside every site, that nobody checked it.
 *
 * The pattern says all that in a form the JSON Schema export keeps, and it
 * stops the check where it fails, so an address copied with a slash at the end
 * is told once. Asking the URL parser for the origin catches what the pattern
 * leaves, such as a punycode label the parser would write differently.
 */
export const SellerSiteSchema = z
  .string()
  .regex(
    /^https:\/\/(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/,
    { message: SITE_FORM, abort: true },
  )
  .refine((site) => {
    try {
      return new URL(site).origin === site;
    } catch {
      return false;
    }
  }, SITE_FORM)
  .meta({ description: `The https origin of a seller's own shop: ${SITE_FORM}.` });
