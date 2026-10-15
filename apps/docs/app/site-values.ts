/**
 * What the documentation says that a deployment decides: the site's own
 * address, the abuse contact, the operator's name and whether the operator's
 * legal identity is published. One build serves every channel, so a page
 * names each of these as a template Caddy fills from its environment when it
 * serves the file, as it fills the notice that names the channel. A writer
 * names a value as `{{origin}}`, and keeps a part of a page off a channel by
 * putting it inside `:::: unless identity-confirmed` … `::::`.
 *
 * Caddy fills what it serves, the page a browser loads and its Markdown, and
 * nothing a script fetches afterwards. A page drawn in the browser after a
 * move from another page is drawn from data the build wrote, so the browser
 * fills the same templates itself from the values Caddy filled into the
 * document it did serve (`served.ts`). The same document carries where the
 * deployment's measurements go, which no page names but the browser reads
 * once a visitor allows measuring.
 */

import type { BrowserAnalyticsConfig } from "@agentify/consent";

/** Each value a page may name, by the name a writer uses, with the variable Caddy reads it from. */
const SITE_VALUES = {
  origin: "AGENTIFY_PUBLIC_ORIGIN",
  "abuse-email": "ABUSE_EMAIL",
  operator: "LEGAL_OPERATOR",
  "identity-confirmed": "LEGAL_IDENTITY_CONFIRMED",
} as const;

export type SiteValueName = keyof typeof SITE_VALUES;

/** Where the deployment's measurements go, as the scanner is told it too. */
const ANALYTICS_SETTINGS = {
  "analytics-runtime": "ANALYTICS_RUNTIME_ENV",
  "posthog-key": "POSTHOG_BROWSER_KEY",
  "posthog-host": "POSTHOG_BROWSER_HOST",
  "posthog-destination": "POSTHOG_DESTINATION_ENV",
  "meta-pixel": "META_PIXEL_ID",
  "meta-destination": "META_DESTINATION_ENV",
} as const;

/** Everything Caddy fills into the document it serves, by name. */
const SERVED = { ...SITE_VALUES, ...ANALYTICS_SETTINGS } as const;

type ServedName = keyof typeof SERVED;

export type SiteValues = Readonly<Record<ServedName, string>>;

const NAMES = Object.keys(SITE_VALUES) as SiteValueName[];

const SERVED_NAMES = Object.keys(SERVED) as ServedName[];

export const isSiteValueName = (name: string): name is SiteValueName =>
  (NAMES as string[]).includes(name);

/**
 * The template Caddy replaces with the value, escaped for HTML, which is also
 * safe in an attribute and harmless in Markdown. Backticks rather than
 * quotes, so the template survives inside an attribute and inside JSON.
 */
export const valueTemplate = (name: ServedName): string =>
  `<!--{{env \`${SERVED[name]}\` | html}}-->`;

/** The start of a part shown unless the value is `true`; `UNLESS_END` closes it. */
export const unlessTemplate = (name: SiteValueName): string =>
  `<!--{{if ne (env \`${SITE_VALUES[name]}\`) "true"}}-->`;

export const UNLESS_END = "<!--{{end}}-->";

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;");

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `html` with every template filled from `values`, as Caddy fills it. A part
 * inside an `unless` is dropped where its value is `true` and kept otherwise;
 * parts do not nest.
 */
export function fillSiteValues(
  html: string,
  values: Readonly<Record<SiteValueName, string>>,
): string {
  let filled = html;
  for (const name of NAMES) {
    filled = filled.replace(
      new RegExp(
        `${escapeRegExp(unlessTemplate(name))}([\\s\\S]*?)${escapeRegExp(UNLESS_END)}`,
        "g",
      ),
      (_whole, kept: string) => (values[name] === "true" ? "" : kept),
    );
    const value = escapeHtml(values[name]);
    filled = filled.replaceAll(valueTemplate(name), () => value);
  }
  return filled;
}

/**
 * The element whose attributes Caddy fills with every value, which the
 * browser reads back (`served.ts`).
 */
export const siteValuesElement = (): string =>
  `<div hidden id="site-values" ${SERVED_NAMES.map((name) => `data-${name}="${valueTemplate(name)}"`).join(" ")}></div>`;

const unescapeHtml = (text: string): string =>
  text
    .replaceAll("&#34;", '"')
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/**
 * The values in the element as served, or null where nobody filled it: in
 * the build itself, and wherever the files are served without Caddy.
 */
export function siteValuesIn(served: string): SiteValues | null {
  // A browser writes the element back as `hidden=""`, and may write a `>`
  // inside an attribute as `&gt;`.
  const attributes = /<div hidden(?:="")? id="site-values"((?:\s+data-[a-z-]+="[^"]*")*)\s*>/.exec(
    served,
  )?.[1];
  if (attributes === undefined) return null;
  const values: Partial<Record<ServedName, string>> = {};
  for (const [, name = "", value = ""] of attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
    if ((SERVED_NAMES as string[]).includes(name)) values[name as ServedName] = unescapeHtml(value);
  }
  const complete = SERVED_NAMES.every((name) => values[name] !== undefined);
  const filled = SERVED_NAMES.every((name) => !values[name]?.includes("<!--{{"));
  return complete && filled ? (values as SiteValues) : null;
}

/**
 * A built page with its templates as Caddy reads them. React writes an
 * attribute's `<` and `>` as entities, so a template in a page's head, such
 * as the site's address in its canonical link, would not be found by Caddy's
 * comment-shaped delimiters; the build writes them back.
 */
export const withTemplatesRestored = (html: string): string =>
  html.replace(/&lt;!--\{\{(.*?)\}\}--&gt;/g, "<!--{{$1}}-->");

const ENVIRONMENTS = ["local", "test", "preview", "production"] as const;

const environmentOf = (written: string) => ENVIRONMENTS.find((each) => each === written);

/**
 * Where measurements go, from the settings Caddy filled in as the scanner is
 * given them, or null where one names an environment the scanner would refuse
 * to start on, so a page sends nothing a misconfigured channel would.
 */
export function analyticsConfigIn(values: SiteValues): BrowserAnalyticsConfig | null {
  const runtimeEnvironment = environmentOf(values["analytics-runtime"]);
  const posthog = environmentOf(values["posthog-destination"]);
  const meta = environmentOf(values["meta-destination"]);
  if (runtimeEnvironment === undefined || posthog === undefined || meta === undefined) return null;
  return {
    runtimeEnvironment,
    posthog: {
      key: values["posthog-key"] || null,
      host: values["posthog-host"] || null,
      destinationEnvironment: posthog,
    },
    meta: { pixelId: values["meta-pixel"] || null, destinationEnvironment: meta },
  };
}
