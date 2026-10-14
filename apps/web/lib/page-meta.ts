import type { MetaDescriptor } from "react-router";

import { type Picture, SITE_PICTURE } from "../content/pictures";
import type { PublicAppConfig } from "./app-config";

/** What a page says of itself in its head; every part may be left to the site's default. */
export type PageHead = Readonly<{
  /**
   * The page's title, followed by the site's name. Absent, the site's own
   * title; with `titleAlone`, the title as written, which only the front page
   * uses.
   */
  title?: string;
  titleAlone?: boolean;
  description?: string;
  /** A path on the site, given absolute against the configured origin. */
  canonical?: string;
  /**
   * What a crawler is asked to do with the page, where it is not left to the
   * crawler: a page no crawler should list, such as the one that says there is
   * no such page, is `noindex`; one that is somebody's own, `noindex, nofollow`.
   */
  robots?: "noindex" | "noindex, nofollow" | "index, follow";
  /** The referrer policy the page asks of the browser, where its address's headers name one too. */
  referrer?: "no-referrer" | "strict-origin";
  /** The card a link to the page unfurls into, where it is not the page's own head over the site's. */
  card?: PageCard;
}>;

/**
 * A card of the page's own. A title or a description left out is the page's;
 * an image left out is the site's. With `addressed`, the card names the page's
 * canonical address and calls it a website.
 */
type PageCard = Readonly<{
  title?: string;
  description?: string;
  image?: Picture;
  addressed?: boolean;
}>;

const DEFAULT_DESCRIPTION =
  "A public-HTTP diagnostic showing what your website makes readable to AI agents.";

/**
 * Where the root route's loader put the site's settings, for a route's `meta`:
 * React Router draws a page's head from the deepest route's `meta` alone, so
 * each page builds the whole head from these.
 */
export function siteConfigOf(
  matches: readonly ({ id: string; loaderData: unknown } | undefined)[],
): PublicAppConfig {
  const root = matches.find((match) => match?.id === "root")?.loaderData as
    | { app?: PublicAppConfig }
    | undefined;
  if (root?.app === undefined)
    throw new Error("a page's head was drawn without the root's settings");
  return root.app;
}

/** The site's own title, which a page without one of its own carries. */
export const siteTitle = (brand: string): string => `${brand} — website agent-readiness diagnostic`;

/** The whole head of a page: its title, description, canonical address and share card. */
export function pageMeta(config: PublicAppConfig, head: PageHead = {}): MetaDescriptor[] {
  const title =
    head.title === undefined
      ? siteTitle(config.displayBrand)
      : head.titleAlone
        ? head.title
        : `${head.title} · ${config.displayBrand}`;
  const description = head.description ?? DEFAULT_DESCRIPTION;
  const picture = head.card?.image ?? SITE_PICTURE;
  const card = {
    title: head.card?.title ?? title,
    description: head.card?.description ?? description,
    image: new URL(picture.path, config.baseUrl).toString(),
  };
  const canonical =
    head.canonical === undefined ? undefined : new URL(head.canonical, config.baseUrl);
  const cardAddress =
    head.card?.addressed === true && canonical !== undefined ? canonical.toString() : undefined;
  return [
    { title },
    { name: "description", content: description },
    ...(head.robots === undefined ? [] : [{ name: "robots", content: head.robots }]),
    ...(head.referrer === undefined ? [] : [{ name: "referrer", content: head.referrer }]),
    ...(canonical === undefined
      ? []
      : [
          {
            tagName: "link",
            rel: "canonical",
            // The front page is named by the origin alone, the form it is indexed under.
            href: canonical.pathname === "/" ? canonical.origin : canonical.toString(),
          },
        ]),
    { property: "og:title", content: card.title },
    { property: "og:description", content: card.description },
    ...(cardAddress === undefined
      ? []
      : [
          { property: "og:url", content: cardAddress },
          { property: "og:type", content: "website" },
        ]),
    { property: "og:image", content: card.image },
    { property: "og:image:type", content: picture.type },
    { property: "og:image:width", content: String(picture.width) },
    { property: "og:image:height", content: String(picture.height) },
    { property: "og:image:alt", content: picture.alt },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: card.title },
    { name: "twitter:description", content: card.description },
    { name: "twitter:image", content: card.image },
    { name: "twitter:image:alt", content: picture.alt },
    { name: "twitter:image:type", content: picture.type },
    { name: "twitter:image:width", content: String(picture.width) },
    { name: "twitter:image:height", content: String(picture.height) },
  ];
}
