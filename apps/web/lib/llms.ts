import { PUBLIC_PAGE_PATHS } from "../content/public-page-metadata";
import { getPublicAppConfig } from "./app-config";

const labels = {
  "/": "Website diagnostic and selling to agents",
  "/store": "Online-store diagnostic",
  "/local": "Local-business diagnostic",
  "/methodology": "Methodology and 18-check rubric",
  "/scanner": "Scanner identity and safety limits",
  "/privacy": "Privacy and data controls",
  "/terms": "Terms of use",
} as const satisfies Record<(typeof PUBLIC_PAGE_PATHS)[number], string>;

export function buildLlmsText(): string {
  const { baseUrl, displayBrand } = getPublicAppConfig();
  const links = PUBLIC_PAGE_PATHS.map(
    (path) => `- [${labels[path]}](${new URL(path, baseUrl).toString()})`,
  );

  return [
    `# ${displayBrand}`,
    "",
    "Agentify is a bounded public-HTTP diagnostic for website agent-readiness. It does not test a particular model's answer, execute tools, log in, or promise rankings, traffic, sales, or certification.",
    "",
    "## Public pages",
    "",
    ...links,
    "",
    "## Selling to agents",
    "",
    "Agentify also runs a merchant channel: an ordinary online business publishes product cards that AI agents buy and pay for over x402, and the money goes from the buyer's wallet to the merchant's.",
    "",
    `- [The sell-to-agents page, for the business owner](${new URL("/agentic-shop", baseUrl).toString()})`,
    `- [Merchant documentation, for the engineer](${new URL("/docs/", baseUrl).toString()})`,
    "",
  ].join("\n");
}
