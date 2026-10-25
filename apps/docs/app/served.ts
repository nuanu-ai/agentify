/**
 * The part of every page Caddy fills when it serves the file: the notice that
 * names the channel, as the dashboard draws it under the site header, and
 * the element holding the site's values. The build writes it with Caddy's
 * templates in it, which a browser cannot fill, so the browser reads it back
 * from the document as served, once, before React draws over anything, and
 * draws that from then on. Drawn again from the build it would show every
 * channel's words at once.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/ui/surface";
import { type SiteValues, siteValuesElement, siteValuesIn } from "./site-values.js";

const notice = (words: string | null): string =>
  `<div class="stack-note"><div class="container"><p class="surface-words">${words ?? ""}</p></div></div>`;

/** What the build writes into every page for Caddy to fill. */
export const servedTemplate = (): string =>
  [
    `<div ${SURFACE_MARKER_ATTRIBUTE}="<!--{{env \`AGENTIFY_SURFACE_MODE\`}}-->">`,
    '<!--{{if eq (env "AGENTIFY_SURFACE_MODE") "test"}}-->',
    notice(SURFACE_WORDS.test),
    '<!--{{else if eq (env "AGENTIFY_SURFACE_MODE") "sandbox"}}-->',
    notice(SURFACE_WORDS.sandbox),
    "<!--{{end}}-->",
    "</div>",
    siteValuesElement(),
  ].join("");

/** The class of the element the served part is drawn in, which is where it is read back from. */
export const SERVED_CLASS = "served";

let read: string | undefined;

/**
 * The served part as the document carried it, read on the first call in a
 * browser; `built` where there is no document, while the build draws the
 * pages and the gallery draws them from its own example.
 */
export function servedPart(built: string): string {
  if (typeof document === "undefined") return built;
  read ??= document.querySelector(`.${SERVED_CLASS}`)?.innerHTML ?? built;
  return read;
}

/** The site's values as served, or null where nobody filled them. */
export const servedValues = (built: string): SiteValues | null => siteValuesIn(servedPart(built));
