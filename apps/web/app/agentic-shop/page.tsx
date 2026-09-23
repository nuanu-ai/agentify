import type { Metadata } from "next";
import Image from "next/image";
import { MarketingHeader, SiteFooter } from "../../components/site-chrome";
import { AGENTIC_SHOP_RESEARCH } from "../../content/agentic-shop";
import { getPublicAppConfig } from "../../lib/app-config";
import styles from "./shop.module.css";

const adobeSource = AGENTIC_SHOP_RESEARCH.sourceUrl;

export function generateMetadata(): Metadata {
  const url = new URL("/agentic-shop", getPublicAppConfig().baseUrl).toString();
  return {
    title: "Sell to agents",
    description:
      "Open your Agentify cabinet with an email link, integrate through the SDK and test agent-ready offers. Live publication requires operator approval.",
    alternates: { canonical: url },
    openGraph: {
      title: "Your next customer sends an agent. Be ready.",
      description: "Your products and services, ready for a new way to buy.",
      url,
      type: "website",
    },
  };
}

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <span aria-hidden="true">{diagonal ? "↗" : "→"}</span>;
}

const categories = [
  [
    "01",
    "Products",
    "Your catalog, ready for agent orders.",
    "Retail · e-commerce · made to order",
  ],
  [
    "02",
    "Places to stay",
    "Rooms and experiences, easier to book.",
    "Hotels · villas · hospitality",
  ],
  [
    "03",
    "Food & experiences",
    "A table, a ticket, a reason to visit.",
    "Restaurants · activities · attractions",
  ],
  [
    "04",
    "Everyday services",
    "Turn available time into bookable offers.",
    "Wellness · fitness · coworking",
  ],
];

export default function AgenticShopPage() {
  return (
    <>
      <MarketingHeader />
      <main className={styles.page} id="main">
        <section className={`container ${styles.hero}`}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>
              <span className={styles.dot} /> Meet your next sales channel
            </p>
            <h1>
              Your next
              <br />
              customer sends
              <br />
              <span>an agent.</span>
            </h1>
            <p className={styles.heroDescription}>
              Your products and services, ready for a new way to buy. An agent finds the offer,
              orders it and pays.
            </p>
            <div className={styles.heroActions}>
              <a className={styles.primary} href="/cabinet/sign-in">
                Open your cabinet <Arrow diagonal />
              </a>
              <a className={styles.textLink} href="#how-it-works">
                See how it works <Arrow />
              </a>
            </div>
            <p className={styles.heroNote}>
              Start in the test channel. Live publication requires approval. No AI assistant is
              guaranteed to recommend or buy your products.
            </p>
          </div>
          <div className={styles.heroVisual}>
            <Image
              src="/agentic-shop/merchant-still-life.png"
              alt="A teal shopping bag, espresso, hotel key card, ticket and folded towel on sunlit stone."
              width={1448}
              height={1086}
              sizes="(max-width: 800px) calc(100vw - 40px), 50vw"
              priority
              className={styles.heroImage}
            />
          </div>
        </section>

        <div className={`container ${styles.promiseStrip}`}>
          <p>
            You run your business.
            <br />
            <strong>We help open the next channel.</strong>
          </p>
          <span>Your products</span>
          <span>Your pricing</span>
          <span>Your fulfilment terms</span>
          <span>Supported payment</span>
        </div>

        <section className={styles.opportunity} id="opportunity">
          <div className="container">
            <div className={styles.marketGrid}>
              <div className={styles.marketCopy}>
                <h2>
                  The buying journey
                  <br />
                  is changing.
                  <br />
                  <span>Don’t sit this one out.</span>
                </h2>
                <p>
                  Customers are already using AI to find what to buy. The next opportunity is making
                  your business easier for their agents to order from.
                </p>
                <a href="/cabinet/sign-in" className={styles.lightLink}>
                  Open your cabinet <Arrow diagonal />
                </a>
              </div>
              <div className={styles.chartCard}>
                <div className={styles.chartHeading}>
                  <span>AI-referred retail traffic</span>
                  <span>U.S. · Q1 · year over year</span>
                </div>
                <div className={styles.growth}>
                  <strong>
                    +{AGENTIC_SHOP_RESEARCH.traffic.growthPercent}
                    <span>%</span>
                  </strong>
                  <p>
                    More visits from AI sources
                    <br />
                    in Q1 2026 vs. Q1 2025
                  </p>
                </div>
                <figure
                  className={styles.chart}
                  aria-label="Indexed AI-referred traffic: Q1 2025 equals 100; Q1 2026 equals 493, a 393 percent increase."
                >
                  <div className={styles.chartLines} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className={styles.barColumn}>
                    <span>100</span>
                    <div className={styles.barOld} />
                    <b>Q1 2025</b>
                  </div>
                  <div className={styles.barColumn}>
                    <span>{AGENTIC_SHOP_RESEARCH.traffic.comparisonIndex}</span>
                    <div className={styles.barNew} />
                    <b>Q1 2026</b>
                  </div>
                  <figcaption>Traffic index · Q1 2025 = 100</figcaption>
                </figure>
                <p className={styles.source}>
                  Source:{" "}
                  <a href={adobeSource} target="_blank" rel="noopener noreferrer">
                    Adobe Digital Insights, April 16, 2026 <Arrow diagonal />
                  </a>
                  . Measures AI-referred visits to U.S. retail sites, not autonomous purchases or
                  x402 volume.
                </p>
              </div>
            </div>
            <div className={styles.marketBottom}>
              <strong>
                +{AGENTIC_SHOP_RESEARCH.conversion.relativeLiftPercent}
                <span>%</span>
              </strong>
              <p>
                Higher conversion for AI-referred visits vs. non-AI traffic.
                <span>
                  U.S. retail · March 2026 · Adobe. Purchases after a visit to a retailer’s website,
                  not checkout inside an AI chat. This does not establish demand for x402 orders.
                </span>
              </p>
              <a href={adobeSource} target="_blank" rel="noopener noreferrer">
                Read the research <Arrow diagonal />
              </a>
            </div>
          </div>
        </section>

        <section id="how-it-works" className={`container ${styles.section}`}>
          <div className={styles.sectionHeading}>
            <h2>
              A new channel.
              <br />A familiar business.
            </h2>
            <p>
              One email link opens the cabinet. Your SDK integration publishes the offers and the
              rules an order follows.
            </p>
          </div>
          <div className={styles.steps}>
            <article>
              <span className={styles.stepNumber}>01</span>
              <div className={styles.stepSymbol} aria-hidden="true">
                ↗
              </div>
              <h3>Open your cabinet.</h3>
              <p>
                Enter your email and use the one-time link. The first visit creates your merchant
                and asks for the name buyers will see.
              </p>
            </article>
            <article>
              <span className={styles.stepNumber}>02</span>
              <div className={styles.stepSymbol} aria-hidden="true">
                ⇄
              </div>
              <h3>Connect your catalog.</h3>
              <p>
                Use the <a href="/docs/quickstart">SDK</a> to publish the offer, price and
                fulfilment promises. The WooCommerce connector is experimental.
              </p>
            </article>
            <article>
              <span className={styles.stepNumber}>03</span>
              <div className={styles.stepSymbol} aria-hidden="true">
                ✓
              </div>
              <h3>Prove it in test.</h3>
              <p>
                Test publication needs the seller name and test payout wallet. Live publication uses
                a separate wallet and also needs the operator’s approval for that merchant.
              </p>
            </article>
          </div>
        </section>

        <section className={styles.settlement}>
          <div className={`container ${styles.settlementGrid}`}>
            <div>
              <h2>
                Set your payout wallet.
                <br />
                <span>Keep test and live distinct.</span>
              </h2>
              <p>
                Buyers pay in USDC and the money goes straight to the wallet in your cabinet. There
                is no payout from us and no settlement period. Test publication stays open while
                live waits for approval.
              </p>
              <div className={styles.settlementLinks}>
                <a className={styles.textLink} href="/cabinet/sign-in">
                  Open your cabinet <Arrow />
                </a>
                <a
                  className={styles.textLink}
                  href="https://docs.cdp.coinbase.com/x402/welcome"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  About x402 <Arrow diagonal />
                </a>
              </div>
            </div>
            <div
              className={styles.paymentDiagram}
              role="group"
              aria-label="Live payment path: the customer's agent, the gateway, your payout wallet."
            >
              <div className={styles.paymentLabel}>LIVE ONLY AFTER OPERATOR APPROVAL</div>
              <div className={styles.paymentRow}>
                <span className={styles.nodeIcon}>01</span>
                <div>
                  <strong>Customer’s agent</strong>
                  <span>Pays in USDC</span>
                </div>
                <span aria-hidden="true">↓</span>
              </div>
              <div className={styles.paymentRow}>
                <span className={styles.nodeIcon}>02</span>
                <div>
                  <strong>The gateway</strong>
                  <span>Checks the payment and sets it going</span>
                </div>
                <span aria-hidden="true">↓</span>
              </div>
              <div className={styles.paymentRow}>
                <span className={styles.nodeIcon}>03</span>
                <div>
                  <strong>Your payout wallet</strong>
                  <span>The address set in your cabinet</span>
                </div>
                <span aria-hidden="true">✓</span>
              </div>
              <p>
                A seller name, payout wallet and operator approval are separate live-publication
                gates. Opening a cabinet grants none of them.
              </p>
            </div>
          </div>
        </section>

        <section
          className={`container ${styles.section}`}
          id="loyalty"
          aria-labelledby="loyalty-title"
        >
          <div className={styles.sectionHeading}>
            <h2 id="loyalty-title">Reward the customer behind the agent.</h2>
            <p>
              Not live yet. The idea is cashback terms an agent can compare, and a record of
              delivering what you promise.
            </p>
          </div>
          <div className={styles.steps}>
            <article>
              <span className={styles.stepSymbol} aria-hidden="true">
                01
              </span>
              <h3>You fund the reward.</h3>
              <p>
                Once your merchant is verified, agree a cashback rate, budget and return rules. An
                agent can read the offer and compare what it is worth to its customer.
              </p>
            </article>
            <article>
              <span className={styles.stepSymbol} aria-hidden="true">
                02
              </span>
              <h3>Delivery unlocks it.</h3>
              <p>
                Cashback becomes payable to the customer only after verified delivery of the product
                or service, under the agreed terms. Payment alone does not trigger a reward.
              </p>
            </article>
            <article>
              <span className={styles.stepSymbol} aria-hidden="true">
                03
              </span>
              <h3>Reliability earns trust.</h3>
              <p>
                Delivery success, service quality and refund speed build a record that agents can
                weigh alongside price and cashback.
              </p>
            </article>
          </div>
          <div className={styles.localNote}>
            <p>
              <strong>A loyalty model we’re developing.</strong> Reward funding and refund reserves
              would be accounted for separately. Program terms and availability must be agreed
              before activation.
            </p>
            <a href="/cabinet/sign-in">
              Open your cabinet <Arrow diagonal />
            </a>
          </div>
        </section>

        <section className={`container ${styles.section}`} id="businesses">
          <div className={styles.sectionHeading}>
            <h2>
              If people can buy it,
              <br />
              let’s explore an agent offer.
            </h2>
            <p>
              From a digital product to a day in Bali. What matters is a process that can fulfil the
              order.
            </p>
          </div>
          <div className={styles.categories}>
            {categories.map(([number, title, description, examples]) => (
              <article key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{description}</p>
                <small>{examples}</small>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.entry} id="start">
          <div className={`container ${styles.entryGrid}`}>
            <div>
              <h2>
                Start with
                <br />
                your email.
              </h2>
              <p>
                The one-time link signs you in or creates your cabinet. No password, no invitation
                code, no review to pass before the test channel.
              </p>
              <ul>
                <li>Choose the seller name buyers see</li>
                <li>
                  Integrate through the <a href="/docs/quickstart">Agentify SDK</a>
                </li>
                <li>Publish and verify offers in the test channel</li>
              </ul>
              <div className={styles.entryNote}>
                Live publication still needs a payout wallet and a one-time operator approval for
                the merchant.
              </div>
            </div>
            <div className={styles.entryCard}>
              <h3>Open the door from your inbox.</h3>
              <p>
                Enter your email in the cabinet. The message works once and expires after one hour.
              </p>
              <a className={styles.primary} href="/cabinet/sign-in">
                Open your cabinet <Arrow diagonal />
              </a>
              <p className={styles.entryFootnote}>
                The mailbox is the key to the cabinet. A shared mailbox means a shared cabinet.
              </p>
            </div>
          </div>
        </section>

        <section className={`container ${styles.section}`} id="questions">
          <div className={styles.sectionHeading}>
            <h2>Questions about selling to agents</h2>
            <p>
              They are answered in the <a href="/docs/faq">merchant documentation</a>.
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
