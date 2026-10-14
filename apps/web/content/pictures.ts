/**
 * The pictures a link to the site unfurls into: where the scanner answers
 * each, its size and type, and the words a page's head gives a reader who
 * cannot see it. They are here rather than beside their drawings so that a
 * page's head can name them without loading the renderer into the browser.
 */

export type Picture = Readonly<{
  path: string;
  type: "image/png";
  width: number;
  height: number;
  alt: string;
}>;

/** The card a link to any page of the site unfurls into. */
export const SITE_PICTURE = {
  path: "/opengraph-image",
  type: "image/png",
  width: 1200,
  height: 630,
  alt: "Agentify website agent-readiness diagnostic",
} as const satisfies Picture;

/**
 * The card a link to the page about selling to agents unfurls into, with the
 * tag drawn beside the brand inside it.
 */
export const SELL_TO_AGENTS_PICTURE = {
  path: "/agentic-shop/opengraph-image",
  type: "image/png",
  width: 1200,
  height: 630,
  alt: "Agentify — Sell to agents: your next customer sends an agent",
  tag: "SELL TO AGENTS",
} as const satisfies Picture & Readonly<{ tag: string }>;
