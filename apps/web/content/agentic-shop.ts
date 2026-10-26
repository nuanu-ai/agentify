import { COMMISSION_RATE, percentagesOf } from "@agentify/core/published";

const { commission, share } = percentagesOf(COMMISSION_RATE);

/** Independent market observations, not Agentify results or x402 transaction volume. */
const AGENTIC_SHOP_RESEARCH = {
  sourceUrl: "https://business.adobe.com/blog/ai-traffic-surge-retail-sites-not-machine-readable",
  publisher: "Adobe Digital Insights",
  publishedAt: "2026-04-16",
  checkedAt: "2026-09-09",
  traffic: {
    geography: "U.S. retail",
    period: "Q1 2026 vs Q1 2025",
    growthPercent: 393,
    baselineIndex: 100,
    comparisonIndex: 493,
  },
  conversion: {
    geography: "U.S. retail",
    period: "March 2026",
    relativeLiftPercent: 42,
    comparison: "AI-referred visits vs non-AI visits",
  },
} as const;

/** Two digits, as a step's number is written: the first is "01". */
export const numbered = (index: number): string => String(index + 1).padStart(2, "0");

const text = (value: string) => ({ kind: "text", value }) as const;
const link = (value: string, href: string) => ({ kind: "link", value, href }) as const;

/**
 * Every word of the page about selling to agents at `/agentic-shop`, which
 * the page draws and its Markdown variant writes out. A title's lines are the
 * lines it breaks into.
 */
export const AGENTIC_SHOP = {
  head: {
    title: "Sell products and services to AI agents",
    description:
      "Open your Agentify dashboard with an email link, integrate through the SDK and test agent-ready offers. Buyers pay in USDC, to your own crypto wallet.",
    cardTitle: "Your next customer sends an agent. Be ready.",
    cardDescription: "Your products and services, ready for a new way to buy.",
  },
  hero: {
    eyebrow: "Meet your next sales channel",
    title: ["Your next", "customer sends", "an agent."],
    description:
      "Your products and services, ready for a new way to buy. An agent finds the offer, orders it and pays in USDC.",
    action: "Open your dashboard",
    howItWorks: "See how it works",
    note: [
      text("Start in the "),
      link("test channel", "https://test.agentify.ad/dashboard/sign-in"),
      text(
        ". Live publication requires approval. No AI assistant is guaranteed to recommend or buy your products.",
      ),
    ],
    imageAlt:
      "A teal shopping bag, espresso, hotel key card, ticket and folded towel on sunlit stone.",
  },
  promise: {
    lead: "You run your business.",
    strong: "We help open the next channel.",
    items: ["Your products", "Your pricing", "Your fulfilment terms", "Supported payment"],
  },
  opportunity: {
    title: ["The buying journey", "is changing.", "Don’t sit this one out."],
    text: "Customers are already using AI to find what to buy. The next opportunity is making your business easier for their agents to order from.",
    action: "Open your dashboard",
    research: AGENTIC_SHOP_RESEARCH,
    chartHeading: ["AI-referred retail traffic", "U.S. · Q1 · year over year"],
    growth: ["More visits from AI sources", "in Q1 2026 vs. Q1 2025"],
    chartLabel:
      "Indexed AI-referred traffic: Q1 2025 equals 100; Q1 2026 equals 493, a 393 percent increase.",
    bars: ["Q1 2025", "Q1 2026"],
    chartCaption: "Traffic index · Q1 2025 = 100",
    source: "Adobe Digital Insights, April 16, 2026",
    sourceScope:
      "Measures AI-referred visits to U.S. retail sites, not autonomous purchases or x402 volume.",
    conversion: "Higher conversion for AI-referred visits vs. non-AI traffic.",
    conversionScope:
      "U.S. retail · March 2026 · Adobe. Purchases after a visit to a retailer’s website, not checkout inside an AI chat. This does not establish demand for x402 orders.",
    readMore: "Read the research",
  },
  how: {
    title: ["A new channel.", "A familiar business."],
    lede: "One email link opens the dashboard. Your SDK integration publishes the offers and the rules an order follows.",
    steps: [
      {
        symbol: "↗",
        title: "Open your dashboard.",
        text: "Enter your email, open the one-time link and press its confirmation button. The dashboard then offers one button, “Open my seller dashboard”, whose press creates your merchant and asks for the name buyers will see.",
      },
      {
        symbol: "⇄",
        title: "Connect your catalog.",
        text: [
          text("Use the "),
          link("SDK", "/docs/quickstart"),
          text(
            " to publish the offer, price and fulfilment promises, or import products from a WooCommerce store.",
          ),
        ],
      },
      {
        symbol: "✓",
        title: "Prove it in test.",
        text: [
          text("The "),
          link("test channel", "https://test.agentify.ad/dashboard/sign-in"),
          text(
            " is an account of its own where buyers pay in test USDC: publish there, then buy your own product to watch the whole path work. Each account publishes once it has a payout wallet, and live sales also need Agentify’s approval.",
          ),
        ],
      },
    ],
  },
  payment: {
    title: ["How you get paid.", "In USDC, to your crypto wallet."],
    text: `Buyers pay in USDC, a digital dollar, on the Base network, into a payout contract made for your crypto wallet. Nobody, Agentify included, can change whom it pays: a payout sends ${share} to your wallet and ${commission} to Agentify, with no subscription and no monthly fee, and you can send one at any time. You need a crypto wallet on Base, such as Coinbase Wallet, which your dashboard can create with you. Turning USDC into bank money happens outside Agentify.`,
    action: "Open your dashboard",
    more: { label: "How the money works", href: "/docs/money" },
    path: {
      label:
        "How a payment reaches you: the customer’s agent, Agentify, your payout contract, your crypto wallet.",
      top: "HOW A PAYMENT REACHES YOU",
      steps: [
        ["Customer’s agent", "Pays in USDC"],
        ["Agentify", "Checks the payment and sets it going"],
        [
          "Your payout contract",
          `Keeps it until it is paid out: ${share} to your wallet, ${commission} to Agentify`,
        ],
        ["Your crypto wallet", "The address saved in your dashboard"],
      ],
    },
  },
  loyalty:
    "Not live yet: cashback you fund for the customer behind the agent, payable only after delivery.",
  businesses: {
    title: ["If people can buy it,", "let’s explore an agent offer."],
    lede: "From a digital product to a day in Bali. What matters is a process that can fulfil the order.",
    categories: [
      {
        title: "Products",
        text: "Your catalog, ready for agent orders.",
        examples: "Retail · e-commerce · made to order",
      },
      {
        title: "Places to stay",
        text: "Rooms and experiences, easier to book.",
        examples: "Hotels · villas · hospitality",
      },
      {
        title: "Food & experiences",
        text: "A table, a ticket, a reason to visit.",
        examples: "Restaurants · activities · attractions",
      },
      {
        title: "Everyday services",
        text: "Turn available time into bookable offers.",
        examples: "Wellness · fitness · coworking",
      },
    ],
  },
  start: {
    title: ["Start with", "your email."],
    text: "The one-time link signs you in, and one button, “Open my seller dashboard”, creates your merchant. No password, no invitation code, no review to pass before the test channel.",
    steps: [
      "Choose the seller name buyers see",
      [text("Integrate through the "), link("Agentify SDK", "/docs/quickstart")],
      "Publish and verify offers in the test channel",
    ],
    card: {
      title: "Open the door from your inbox.",
      text: "Enter your email in the dashboard. The message works once and expires after one hour.",
      action: "Open your dashboard",
      footnote:
        "The mailbox is the key to the dashboard. A shared mailbox means a shared dashboard.",
    },
  },
  questions: {
    title: "Questions about selling to agents",
    text: [text("They are answered in the "), link("merchant documentation", "/docs/"), text(".")],
  },
} as const;
