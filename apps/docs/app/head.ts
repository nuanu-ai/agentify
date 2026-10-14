/**
 * What a page of the documentation says of itself in its head and to a
 * crawler. Every address in it is whole, so it starts with the site's own,
 * which a deployment decides: the build writes Caddy's template for it, and
 * a page the browser draws after a move names the address Caddy filled into
 * the document it served.
 */

import { SITE_PICTURE, siteSchema } from "@agentify/ui";
import { docsAddress } from "@agentify/ui/docs";
import type { MetaDescriptor } from "react-router";
import { servedValues } from "./served.js";
import { type SiteValueName, valueTemplate } from "./site-values.js";

const BRAND = "Agentify";

/** A site value as this document has it: filled where it was served by Caddy, the template where not. */
const siteValue = (built: string, name: SiteValueName): string =>
  servedValues(built)?.[name] ?? valueTemplate(name);

export type Head = Readonly<{
  path: string;
  title: string;
  description: string;
  /** The site's picture on a link's card, as the scanner's pages carry it. */
  site: boolean;
}>;

/** The head of one page; `built` is the served part the build wrote. */
export function headOf(head: Head, built: string): MetaDescriptor[] {
  const origin = siteValue(built, "origin");
  const title = `${head.title} · ${BRAND}`;
  return [
    { title },
    { name: "description", content: head.description },
    { tagName: "link", rel: "canonical", href: `${origin}${docsAddress(head.path)}` },
    { property: "og:title", content: title },
    { property: "og:description", content: head.description },
    ...(head.site
      ? [
          { property: "og:image", content: `${origin}${SITE_PICTURE.path}` },
          { property: "og:image:type", content: SITE_PICTURE.type },
          { property: "og:image:width", content: String(SITE_PICTURE.width) },
          { property: "og:image:height", content: String(SITE_PICTURE.height) },
          { property: "og:image:alt", content: SITE_PICTURE.alt },
          { name: "twitter:card", content: "summary_large_image" },
          { name: "twitter:image", content: `${origin}${SITE_PICTURE.path}` },
          { name: "twitter:image:alt", content: SITE_PICTURE.alt },
        ]
      : [{ name: "twitter:card", content: "summary" }]),
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: head.description },
  ];
}

/**
 * The site and its operator for a crawler, as a script's text: `<` escaped
 * so nothing in it can close the script, except where it opens one of
 * Caddy's templates, which Caddy replaces before any browser reads it.
 */
export const structuredDataOf = (built: string): string =>
  JSON.stringify(
    siteSchema({
      brand: BRAND,
      origin: siteValue(built, "origin"),
      abuseEmail: siteValue(built, "abuse-email"),
    }),
  ).replace(/<(?!!--\{\{)/g, "\\u003c");
