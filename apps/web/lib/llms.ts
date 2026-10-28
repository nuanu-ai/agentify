import {
  COMMISSION_RATE,
  durationInWords,
  percentagesOf,
  QUOTE_TTL_MS,
} from "@agentify/core/published";
import { DOCS_PAGES, docsAddress } from "@agentify/ui/docs";
import { ShipToSchema } from "@nuanu-ai/agentify-contracts";
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

const { commission, share } = percentagesOf(COMMISSION_RATE);

/** A parcel's purchase, with the example address the contract's own schema publishes. */
const parcelPurchase = (): string => {
  const [address] = (ShipToSchema.meta()?.examples as readonly unknown[] | undefined) ?? [];
  if (address === undefined) throw new Error("the contract's address schema publishes no example");
  return JSON.stringify({ params: {}, ship_to: address });
};

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
    `Agentify also runs a merchant channel: an ordinary online business publishes product cards that AI agents buy and pay for over x402. The buyer pays into the merchant's own payout contract, which nobody owns and which sends ${share} to the merchant's wallet and ${commission} to Agentify when it is paid out.`,
    "",
    "Before paying, read the card's `fulfillment`. A `sync` purchase is charged after the merchant delivers goods to Agentify. An `async` or `ship` purchase is charged before delivery or shipment, which may still fail or miss the card's deadline. Read the merchant's cancellation, refund and support terms at `seller.site` before authorizing that payment; if the site does not state them, those terms are unknown. The merchant supplies the site, and Agentify verifies neither ownership nor those terms. The merchant handles refunds; Agentify does not confirm that a refund happened.",
    "",
    `To buy, POST \`{"params": {...}}\`, holding the fields the item's \`params\` declare and empty when it declares none, with the address under \`ship_to\` beside it for an item whose \`fulfillment\` is \`ship\`, to the item's \`purchase_url\` in the catalogue. The first answer is a 402 whose x402 version 2 payment requirements are in the \`PAYMENT-REQUIRED\` header. The price in them holds for ${durationInWords(QUOTE_TTL_MS, "second")}, counted to when your paid request reaches Agentify rather than to when you sign, so sign and send the payment at once, in a \`PAYMENT-SIGNATURE\` header on the same POST. The paid request is answered with the order: the goods are in its \`delivered\`, or, where they come later, its \`status_url\` is read again while its \`status\` reads \`in_progress\`. The answer's \`status_url\` carries your buyer's key, the only key to the order and its goods: keep that address to yourself. Its \`order_id\` is not a secret; it is what you quote to the seller. A standard x402 client from \`@x402/core\` 2.23.0 on refuses to sign any payment above 1 USD unless its operator raises \`maxAmountPerPayment\` in the client's spend controls, so an item priced above that needs that first.`,
    "",
    "The payment requirements carry an opaque stamped price under `extra.price_stamp`, which you return unchanged. Asking for a price creates no order. The paid request repeats the whole purchase body, `ship_to` included for a parcel; its locality must be the one priced, and the full address of the first payer whose payment verifies is the one the parcel goes to. A change to the product's published terms, or to where its seller is paid, cancels an unpaid price before any money moves, and you ask for a new one; the product published again unchanged keeps it. An order keeps the terms it was sold under.",
    "",
    "A 402 that answers a payment signed against the catalogue's listing says so in its `error`: nothing was charged, and that 402 carries the price to sign. An answer of `seller_busy` (HTTP 429), or `payment_not_taken` marked retryable, comes with `Retry-After`: nothing was charged for that request, so wait that long and send the same request again, with the same payment if it carried one. An HTTP 409 answer that carries an order is about that order: read its `payment_status` before buying again.",
    "",
    "If the answer is lost, sign the same payment requirements again from the same wallet: the order comes back with no second charge, or, if it ended with nothing charged or your payment's outcome is not known yet, a refusal that says so. Keep the payment requirements you were given and the payment you signed until you have the answer, because getting a lost answer back needs both: the requirements to sign again, and the payment to tell you which wallet has to sign. Asking the purchase_url again without the kept payment requirements starts a new purchase, which is charged again once paid. Standard x402 clients keep nothing they signed, so their plain retry after a lost answer is that new purchase. Keep the 402 you signed, which the client's `onAfterPaymentCreation` hook sees, and if you did not keep it, do not buy again: first check the wallet for a transfer to the requirements' `payTo`.",
    "",
    `A parcel's purchase without params, with an example address: \`${parcelPurchase()}\`. Send the buyer's own address: a body that repeats an item's listed example, where the item asks for a text param or an address, is answered as a look at the item's listing, which carries no price to sign. In \`ship_to\`, \`name\`, \`line_one\`, \`city\`, \`country\` and \`phone_number\` are required, and \`line_two\`, \`state\` and \`postal_code\` are given where the address has them. \`country\` is ISO 3166-1 alpha-2, and \`state\` is the subdivision code without the country in front.`,
    "",
    `- [The sell-to-agents page, for the business owner](${whole("/agentic-shop")})`,
    `- [The catalogue AI agents buy from, as JSON](${whole("/x402/catalog")})`,
    "",
  ].join("\n");
}
