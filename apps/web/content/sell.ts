/**
 * Every word of the merchant landing at `/sell`. A non-breaking space holds
 * "AI agents" on one line where the words would otherwise part.
 */

export const SELL_LANDING = {
  head: {
    title: "Agentify — sell products and services to AI agents",
    description:
      "Publish digital products and services for AI agents, and physical products on the test channel for now, take orders, and get paid out in USDC to your own crypto wallet.",
    cardTitle: "Agentify — sell to AI agents",
    cardDescription: "Catalog, orders, and payouts for agentic commerce.",
  },
  hero: {
    eyebrow: "A new sales channel for products and services",
    title: "AI agents find and buy your products",
    lede: "Connect your catalog of digital products and services once, and physical products on the test channel for now. Agentify shows them to AI agents and takes the order. The buyer pays in USDC, a digital dollar, into your own payout contract, made for your crypto wallet; the contract sends 99.9% to your wallet and 0.1% to Agentify when it is paid out. You keep your site and your store as they are.",
    action: "Connect your catalog",
    howItWorks: "How it works",
    facts: ["You connect your catalog", "An agent buys", "You get paid"],
  },
  sale: {
    label:
      "An AI agent buys a 12 USD bag of specialty coffee through Agentify and pays 12 USDC into the seller's payout contract",
    top: "SELLING TO AI AGENTS THROUGH AGENTIFY",
    status: "PAID",
    agent: {
      kind: "AI AGENT",
      wants: "Found a product and wants to buy it",
      done: "✓ Order created",
    },
    store: { kind: "YOUR STORE", name: "Product catalog" },
    product: { name: "Specialty coffee, 250 g", price: "12 USD" },
    paid: {
      kind: "YOUR PAYOUT CONTRACT",
      amount: "+ 12.00 USDC",
      note: "99.9% to your wallet, 0.1% to Agentify",
    },
    path: ["AI agent", "Agentify", "Your store"],
    end: "Payout to you",
  },
  journey: {
    eyebrow: "How a sale works",
    title: "From adding a product to getting paid",
    lede: "You bring your catalog and fulfill the orders. Agentify handles the rest: it turns your products into cards for AI agents, takes orders, and checks payments.",
    steps: [
      {
        title: "Bring your products to Agentify",
        text: "Connect your catalog through the SDK, or import supported products from your WooCommerce store, on the test channel for now.",
      },
      {
        title: "Agentify publishes cards",
        text: "The description, price, and purchase terms go into a card that AI agents can read, and the card is published in the Agentify catalog.",
      },
      {
        title: "An AI agent buys the product",
        text: "The agent finds the card, picks the product, and pays for the order. Agentify checks the payment and passes the order to you.",
      },
      {
        title: "You get paid",
        text: "The payment goes into your payout contract, which sends 99.9% to your wallet and 0.1% to Agentify whenever it is paid out, and you can pay it out at any time. The order and its payment confirmation are saved in your dashboard.",
      },
    ],
  },
  card: {
    eyebrow: "What a product card contains",
    title: "AI agents see the purchase terms up front",
    lede: "Before buying, an AI agent gets four answers from the card:",
    fields: [
      ["What is for sale", "Title and description"],
      ["How much it costs", "The product price"],
      ["What the buyer provides", "For example, an email or shipping destination"],
      ["How the order is fulfilled", "Immediately, later, or by shipment"],
    ],
    after: "With the SDK, you set these fields in code, as in the example.",
    link: "See every card field in the docs →",
    codeLabel: "example card for developers",
    /** The example as it is highlighted: a pair is a token and its kind, a string plain text. */
    code: [
      ["await", "key"],
      " agentify.catalog.",
      ["publish", "call"],
      "({\n  merchant_item_id:\n    ",
      ["'coffee-pickup-250g'", "str"],
      ",\n  title: ",
      ["'Specialty coffee, 250 g'", "str"],
      ",\n  description:\n    ",
      ["'Fresh coffee; pickup in 24h'", "str"],
      ",\n  price: ",
      ["'12.00 USD'", "str"],
      ",\n  params: {\n    pickup_name: {\n      type: ",
      ["'string'", "str"],
      ",\n      required: ",
      ["true", "key"],
      "\n    }\n  },\n  result: {\n    pickup_code: ",
      ["'string'", "str"],
      ",\n    ready_at: ",
      ["'string'", "str"],
      "\n  },\n  fulfillment: ",
      ["'async'", "str"],
      "\n})",
    ] as readonly (string | readonly [string, "key" | "call" | "str"])[],
  },
  connect: {
    eyebrow: "Two ways to connect",
    title: "Start with what your business already has",
    woo: {
      tag: "No new storefront",
      title: "A WooCommerce store",
      text: "Connect your store, import supported products, and manage their cards from the dashboard. Agentify never gets your store password. The connector works on the test channel only for now and supports a limited set of WooCommerce product configurations.",
      points: [
        "Product cards imported from your store",
        "Orders created in your store",
        "Importing again updates your cards",
      ],
      action: "Create an account",
    },
    sdk: {
      tag: "For your own platform",
      title: "SDK integration",
      text: "Your developer publishes cards from code and runs an SDK module that handles the orders. The module fetches new orders itself, so your server does not need to accept incoming requests.",
      points: [
        "You control the cards and fulfillment",
        "A key on every order prevents duplicate fulfillment",
        "API keys in your dashboard",
      ],
      action: "How to connect the SDK",
    },
  },
  money: {
    eyebrow: "Your own payout contract",
    title: "Agentify never holds your money",
    lede: "For now, payments are accepted in USDC only. You can set the price in USD or USDC, and the AI agent pays the same amount in USDC, with no currency conversion, into your own payout contract. Nobody owns that contract, so neither Agentify nor anyone else can redirect the money: it keeps it until it is paid out, then sends 99.9% to your wallet and 0.1% to Agentify.",
    notes: [
      "0.1% commission, inside the price",
      "Get paid out at any time",
      "Your wallet keys stay with you",
      "Orders and receipts in your dashboard",
    ],
    map: {
      label:
        "An AI agent pays 5 USDC into the seller's payout contract, and Agentify checks the payment; a payout sends 99.9% to the seller's wallet and 0.1% to Agentify",
      top: "ORDER PAYMENT",
      status: "CONFIRMED",
      buyer: { kind: "BUYER'S WALLET", name: "AI agent", amount: "− 5.00 USDC" },
      flow: { amount: "5.00 USDC", note: "Agentify checked the payment" },
      seller: { kind: "YOUR PAYOUT CONTRACT", name: "Seller", amount: "+ 5.00 USDC" },
      foot: "When it is paid out: 99.9% to your wallet, 0.1% to Agentify",
    },
  },
  pricing: {
    eyebrow: "Pricing",
    title: "How much Agentify costs",
    action: "Connect your catalog",
    includesTitle: "What you get",
    options: [
      {
        id: "commission",
        name: "Pay per order",
        price: "0.1%",
        per: "of every paid order",
        gist: "You pay only when agents buy.",
        terms: [
          "Free to connect, no monthly fee.",
          "Inside your price: the buyer pays your price and nothing on top.",
        ],
        includes: [
          "Catalog connection through WooCommerce or the SDK",
          "Product cards in the Agentify catalog",
          "Orders and receipts in your dashboard",
          "Payouts to your wallet at any time",
        ],
      },
    ],
  },
  dashboard: {
    eyebrow: "Seller dashboard",
    title: "All your sales to AI agents in one dashboard",
    lede: "Agentify ties together your catalog, purchases, and payments. The dashboard shows what happens to each product, from publishing its card to fulfilling the order.",
    parts: [
      ["Product cards", "Title, price, and availability. You can pause any card."],
      ["Orders", "What the agent bought, whether the order is paid, and how it was fulfilled."],
      ["Receipts", "Proof of every payment and a history of completed sales."],
      ["Integrations", "The WooCommerce connection and API keys for the SDK."],
      ["Settings", "Seller name, payout wallet, how to get paid out, and account access."],
    ],
    action: "Sign in to your dashboard",
    window: {
      brand: "Agentify",
      kind: "SELLER DASHBOARD",
      sections: ["Cards", "Orders", "Receipts", "Integrations", "API keys", "Settings"],
      help: ["Need help?", "Open the docs →"],
      account: { initial: "M", name: "Account", email: "merchant@example.com" },
      heading: "Product cards",
      stop: "Pause all sales",
      segments: [
        ["All", "3"],
        ["On sale", "2"],
        ["Off sale", "1"],
      ],
      columns: ["Product", "Price", "Delivery", "State"],
      rows: [
        ["Monthly service access", "access-monthly", "5.00 USD", "Immediate", "On sale"],
        ["Specialty coffee", "coffee-250g", "12.00 USD", "By parcel", "On sale"],
        ["30-minute consultation", "consult-30", "30.00 USD", "Later", "Paused by you"],
      ],
      note: "A pause takes a card off sale; orders you have already accepted play out as usual.",
    },
  },
  questions: {
    eyebrow: "FAQ",
    title: "What to know before you connect",
    answers: [
      [
        "Do I need to rebuild my site?",
        "No. Agentify works next to your current site or store, through the SDK or a WooCommerce connection.",
      ],
      [
        "What products can I connect?",
        "Digital products and services can be connected. Physical products, shipped as a parcel, sell on the test channel only for now. Each card tells the agent what it is buying, what information the order needs, and whether fulfillment is immediate, later, or shipped.",
      ],
      [
        "Can I set a price in another currency?",
        "Not yet. Agentify accepts prices in USD or USDC only and does not convert currencies. If you work in EUR, GBP, or another currency, you set the USD or USDC price yourself.",
      ],
      [
        "Where is my money held?",
        "In your own payout contract, until it is paid out. Nobody owns that contract, so neither Agentify nor anyone else can redirect the money: a payout sends 99.9% to your wallet and 0.1% to Agentify, and you can send one at any time.",
      ],
      [
        "Do I need a password for the dashboard?",
        "No. Enter your email, and we'll send you a one-time sign-in link. Open it and confirm the sign-in. The first time, Agentify creates your dashboard and asks for a seller name. After that, the link opens your existing dashboard.",
      ],
    ],
  },
  closing: {
    eyebrow: "Your next sales channel",
    title: "Get your catalog ready for AI agents to buy",
    text: "Create an account, choose a seller name, and connect your first product.",
  },
  links: {
    howItWorks: "How it works",
    integrations: "Integrations",
    payments: "Payments",
    pricing: "Pricing",
    documentation: "Documentation",
    signIn: "Sign in",
    signUp: "Sign up",
  },
};

export type SellLanding = typeof SELL_LANDING;
