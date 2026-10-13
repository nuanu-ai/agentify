/**
 * The picture a link to the page about selling to agents unfurls into: where
 * the scanner answers it, its size and type, the words a page's head gives a
 * reader who cannot see it, and the tag drawn beside the brand inside it. It
 * is here rather than beside the drawing so that a page's head can name it
 * without loading the renderer into the browser.
 */
export const SELL_TO_AGENTS_PICTURE = {
  path: "/agentic-shop/opengraph-image",
  type: "image/png",
  width: 1200,
  height: 630,
  alt: "Agentify — Sell to agents: your next customer sends an agent",
  tag: "SELL TO AGENTS",
} as const;
