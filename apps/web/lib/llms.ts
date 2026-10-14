import { DOCS_PAGES, docsAddress } from "@agentify/ui/docs";
import { PUBLIC_PAGE_PATHS } from "../content/public-page-metadata";
import { getPublicAppConfig } from "./app-config";

const labels = {
  "/": "Website diagnostic and selling to agents",
  "/store": "Online-store diagnostic",
  "/local": "Local-business diagnostic",
  "/privacy": "Privacy and data controls",
  "/terms": "Terms of use",
} as const satisfies Record<(typeof PUBLIC_PAGE_PATHS)[number], string>;

export function buildLlmsText(): string {
  const { baseUrl, displayBrand } = getPublicAppConfig();
  const whole = (path: string): string => new URL(path, baseUrl).toString();
  const links = PUBLIC_PAGE_PATHS.map((path) => `- [${labels[path]}](${whole(path)})`);
  const documentation = DOCS_PAGES.map(
    (page) => `- [${page.label}](${whole(docsAddress(page.path))})`,
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
    "## Documentation",
    "",
    "How a merchant connects to Agentify and sells to agents, for the owner and for the engineer, and how the scanner works and identifies itself. Every page is answered as Markdown to a client that asks for it.",
    "",
    ...documentation,
    "",
    "## Selling to agents",
    "",
    "Agentify also runs a merchant channel: an ordinary online business publishes product cards that AI agents buy and pay for over x402, and the money goes from the buyer's wallet to the merchant's.",
    "",
    `- [The sell-to-agents page, for the business owner](${whole("/agentic-shop")})`,
    `- [The catalogue AI agents buy from, as JSON](${whole("/x402/catalog")})`,
    "",
  ].join("\n");
}
