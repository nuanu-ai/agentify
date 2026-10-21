import { DOCS_PAGES, docsAddress } from "@agentify/ui/docs";
import { PUBLIC_PAGE_PATHS } from "../content/public-page-metadata";
import { getPublicAppConfig } from "./app-config";
import { surfaceMode } from "./server/config";

const labels = {
  "/": "Website diagnostic and selling to agents",
  "/store": "Online-store diagnostic",
  "/local": "Local-business diagnostic",
  "/privacy": "Privacy and data controls",
  "/terms": "Terms of use",
} as const satisfies Record<(typeof PUBLIC_PAGE_PATHS)[number], string>;

const LIVE_SITE = "https://agentify.ad";

/**
 * What the text opens with on each kind of stack: an agent that reads it must
 * not take test or pretend money for real, nor this stack for the live site.
 */
const opening = (displayBrand: string) => ({
  live: [`# ${displayBrand}`],
  test: [
    `# ${displayBrand}'s test channel, paid in test money on Base Sepolia: the live site is ${LIVE_SITE}`,
    "",
    "A merchant's engineer tries an integration here before selling for real. Payments are test USDC on Base Sepolia (eip155:84532), so the money is not real; buying here works as described below, with this channel's catalogue.",
  ],
  sandbox: [
    `# ${displayBrand}'s sandbox, where no payment is real: the live site is ${LIVE_SITE}`,
    "",
    "No chain stands behind this stack: every payment it accepts is pretend, nothing arrives at the address in a payment challenge, and no receipt it writes points at a transfer.",
  ],
});

export function buildLlmsText(): string {
  const { baseUrl, displayBrand } = getPublicAppConfig();
  const opened =
    opening(displayBrand)[surfaceMode.parse(process.env.AGENTIFY_SURFACE_MODE ?? "sandbox")];
  const whole = (path: string): string => new URL(path, baseUrl).toString();
  const links = PUBLIC_PAGE_PATHS.map((path) => `- [${labels[path]}](${whole(path)})`);
  const documentation = DOCS_PAGES.map(
    (page) => `- [${page.label}](${whole(docsAddress(page.path))})`,
  );

  return [
    ...opened,
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
    "Agentify also runs a merchant channel: an ordinary online business publishes product cards that AI agents buy and pay for over x402. The buyer pays into the merchant's own payout contract, which nobody owns and which sends 99.9% to the merchant's wallet and 0.1% to Agentify when it is paid out.",
    "",
    "To buy, POST `{\"params\": {...}}`, holding the fields the item's `params` declare and empty when it declares none, with the address under `ship_to` beside it for an item whose `fulfillment` is `ship`, to the item's `purchase_url` in the catalogue. The first answer is a 402 whose x402 version 2 payment requirements are in the `PAYMENT-REQUIRED` header; the price in them holds for thirty seconds, so sign and send the payment at once, in a `PAYMENT-SIGNATURE` header on the same POST. It is answered with the order: the goods are in its `delivered`, or, where they come later, its `status_url` is read again while its `status` reads `in_progress`. The payment requirements name the order by a `payment_ref`, which only binds your payment to it; the `order_id` in the answer and its `status_url` are the only key to the order and its goods: keep them to yourself. If the answer is lost, sign the same payment requirements again from the same wallet: the order comes back with no second charge, or, if it ended with nothing charged or your payment's outcome is not known yet, a refusal that says so. Asking the purchase_url again without the kept payment requirements starts a new purchase, which is charged again once paid.",
    "",
    `- [The sell-to-agents page, for the business owner](${whole("/agentic-shop")})`,
    `- [The catalogue AI agents buy from, as JSON](${whole("/x402/catalog")})`,
    "",
  ].join("\n");
}
