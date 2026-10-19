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

const text = (value: string) => ({ kind: "text", value }) as const;
const link = (value: string, href: string) => ({ kind: "link", value, href }) as const;

/**
 * Every word of the page about selling to agents at `/agentic-shop`, which
 * the page draws and its Markdown variant writes out. A title's lines are the
 * lines it breaks into; the last is the one drawn in the accent.
 */
export const AGENTIC_SHOP = {
  head: {
    title: "Sell products and services to AI agents",
    description:
      "Open your Agentify dashboard with an email link, integrate through the SDK and test agent-ready offers. Live publication requires operator approval.",
    cardTitle: "Your next customer sends an agent. Be ready.",
    cardDescription: "Your products and services, ready for a new way to buy.",
  },
  hero: {
    eyebrow: "Meet your next sales channel",
    title: ["Your next", "customer sends", "an agent."],
    description:
      "Your products and services, ready for a new way to buy. An agent finds the offer, orders it and pays.",
    action: "Open your dashboard",
    howItWorks: "See how it works",
    note: "Start in the test channel. Live publication requires approval. No AI assistant is guaranteed to recommend or buy your products.",
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
        text: "Enter your email and use the one-time link. The first visit creates your merchant and asks for the name buyers will see.",
      },
      {
        symbol: "⇄",
        title: "Connect your catalog.",
        text: [
          text("Use the "),
          link("SDK", "/docs/quickstart"),
          text(
            " to publish the offer, price and fulfilment promises, or import products from a WooCommerce store, on the test channel for now.",
          ),
        ],
      },
      {
        symbol: "✓",
        title: "Prove it in test.",
        text: "Test publication needs the seller name and test payout wallet. Live publication uses a separate wallet and also needs the operator’s approval for that merchant.",
      },
    ],
  },
  payment: {
    title: ["Set your payout wallet.", "Keep test and live distinct."],
    text: "Buyers pay in USDC into your own payout contract, which nobody owns and nobody can redirect. It sends 99.9% to the wallet in your dashboard and 0.1% to Agentify when it is paid out, and you can pay it out yourself at any time. Test publication stays open while live waits for approval.",
    action: "Open your dashboard",
    more: { label: "About x402", href: "https://docs.cdp.coinbase.com/x402/welcome" },
    path: {
      label:
        "Live payment path: the customer's agent, the gateway, your payout contract, your payout wallet.",
      top: "LIVE ONLY AFTER OPERATOR APPROVAL",
      steps: [
        ["Customer’s agent", "Pays in USDC"],
        ["The gateway", "Checks the payment and sets it going"],
        [
          "Your payout contract",
          "Keeps it until it is paid out: 99.9% to your wallet, 0.1% to Agentify",
        ],
        ["Your payout wallet", "The address set in your dashboard"],
      ],
      foot: "Publishing needs a seller name and a payout wallet, on the test channel as well as live, and live publication also needs the operator’s approval. Opening a dashboard grants none of them.",
    },
  },
  loyalty: {
    title: "Reward the customer behind the agent.",
    lede: "Not live yet. The idea is cashback terms an agent can compare, and a record of delivering what you promise.",
    steps: [
      {
        title: "You fund the reward.",
        text: "Once your merchant is verified, agree a cashback rate, budget and return rules. An agent can read the offer and compare what it is worth to its customer.",
      },
      {
        title: "Delivery unlocks it.",
        text: "Cashback becomes payable to the customer only after verified delivery of the product or service, under the agreed terms. Payment alone does not trigger a reward.",
      },
      {
        title: "Reliability earns trust.",
        text: "Delivery success, service quality and refund speed build a record that agents can weigh alongside price and cashback.",
      },
    ],
    note: {
      strong: "A loyalty model we’re developing.",
      text: "Reward funding and refund reserves would be accounted for separately. Program terms and availability must be agreed before activation.",
    },
    action: "Open your dashboard",
  },
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
    text: "The one-time link signs you in or creates your dashboard. No password, no invitation code, no review to pass before the test channel.",
    steps: [
      "Choose the seller name buyers see",
      [text("Integrate through the "), link("Agentify SDK", "/docs/quickstart")],
      "Publish and verify offers in the test channel",
    ],
    note: "Publishing in the test channel also needs a test payout wallet. Live publication needs a wallet of its own and a one-time operator approval for the merchant.",
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
    text: [
      text("They are answered in the "),
      link("merchant documentation", "/docs/faq"),
      text("."),
    ],
  },
} as const;
