/**
 * The address of a seller's own shop. The card that names it and a parcel's
 * tracking page, whose host is held to the same rule, both read it from here.
 */

import { z } from "zod";

/** What a seller's site is held to, said once for the refusal and the description. */
const SITE_FORM =
  "a seller's site is https:// and the domain name of their shop, with nothing after it — https://shop.example: in lower case, a domain name rather than an IP address or a single word, with no path, query, fragment, port, credentials or trailing slash";

/**
 * The address of a seller's own shop on the web, where an agent takes what an
 * order cannot answer.
 *
 * Only an https origin is accepted, `https://shop.example`, because anything
 * after the host would be the merchant's own text reaching every agent that
 * reads the card. The host must be a domain name: a single word or an IP
 * address is refused, since either can point other people's agents into
 * somebody's own network. The check cannot tell a public name from a private
 * one, so an agent is told beside every site that nobody checked where it
 * leads.
 */
export const SellerSiteSchema = z
  .string()
  .regex(
    /^https:\/\/(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/,
    { message: SITE_FORM, abort: true },
  )
  // The pattern is what the JSON Schema export carries; the URL parser catches
  // what the pattern cannot, such as a punycode label it would write differently.
  .refine((site) => {
    try {
      return new URL(site).origin === site;
    } catch {
      return false;
    }
  }, SITE_FORM)
  .meta({ description: `The https origin of a seller's own shop: ${SITE_FORM}.` });
