import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { BrandMark } from "../../components/brand-mark";
import { getPublicAppConfig } from "../../lib/app-config";
import styles from "./shop.module.css";
import { AGENTIC_SHOP_RESEARCH } from "../../content/agentic-shop";

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

const questions = [
  [
    "Do I need to understand crypto or build an API?",
    "No crypto expertise is needed to open a cabinet. Publishing through the current product path requires an engineer to integrate the Agentify SDK. The WooCommerce connector is experimental.",
  ],
  [
    "Can you connect a local business?",
    "A cabinet can represent a local business when its offers and fulfilment fit a supported integration. Creating a cabinet does not promise a bespoke booking connection or live publication.",
  ],
  [
    "Will I receive money in my bank account?",
    "No bank settlement service is active. The live channel uses a supported payout wallet. A seller name, that wallet and an operator approval are all required before live publication.",
  ],
  [
    "Do you guarantee sales or placement in an AI assistant?",
    "No. Offers from a supported ordering channel may be published through compatible discovery surfaces. Visibility, traffic and sales depend on adoption and demand. No specific AI assistant is guaranteed to recommend or buy your products.",
  ],
  [
    "Who controls prices, availability and cancellations?",
    "You control the products, prices and availability that your integration publishes. An order follows the public contract attached to that offer; the cabinet does not invent availability, cancellation or refund terms that the integration did not provide.",
  ],
  [
    "How would agent loyalty work?",
    "The proposed model combines merchant-funded cashback with a record of reliable service. You set a funded reward budget and clear terms that an agent can compare for its customer. A reward becomes payable only after verified delivery, subject to agreed return rules. The benefit belongs to the customer; a bigger reward does not guarantee an agent’s recommendation. This program is not live yet.",
  ],
  [
    "What happens after I open a cabinet?",
    "The email link creates or opens your merchant cabinet. Set the name buyers see and the test payout wallet, integrate the SDK, and publish against the test channel. Live publication uses a separate wallet and remains closed until an operator approves the merchant.",
  ],
];

export default function AgenticShopPage() {
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <div className={styles.container}>
          <Link className={styles.brand} href="/" aria-label="Agentify home">
            <BrandMark className={styles.mark} />
            <span>Agentify</span>
          </Link>
          <nav aria-label="Page sections" className={styles.nav}>
            <a href="#opportunity">The opportunity</a>
            <a href="#how-it-works">How it works</a>
            <a href="#loyalty">Agent loyalty</a>
            <a href="#questions">Questions</a>
          </nav>
          <a href="/docs/" className={styles.headerDocs}>
            Docs
          </a>
          <a href="/cabinet/sign-in" className={styles.headerCta}>
            Open your cabinet <Arrow diagonal />
          </a>
        </div>
      </header>

      <main id="main">
        <section className={`${styles.container} ${styles.hero}`}>
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
              Make your products and services ready for a new way to buy. We
              help connect your business to AI agents—from the first offer to
              the final order.
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
              Start in the test channel. Live publication requires approval.
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
            <div className={styles.imageLabel}>
              Real businesses.
              <br />A new way to reach them.
            </div>
            <div className={styles.offerCard}>
              <div className={styles.offerIcon}>
                <BrandMark />
              </div>
              <div>
                <span className={styles.offerSmall}>THE SELLING MODEL</span>
                <strong>Your business, agent-ready.</strong>
                <span>Discover → order → fulfil</span>
              </div>
              <Arrow diagonal />
            </div>
          </div>
        </section>

        <div className={`${styles.container} ${styles.promiseStrip}`}>
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
          <div className={styles.container}>
            <div className={styles.sectionTop}>
              <p className={styles.eyebrow}>
                01 / The shift is already happening
              </p>
              <span className={styles.sectionMeta}>
                Independent market data · Adobe
              </span>
            </div>
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
                  Customers are already using AI to find what to buy. The next
                  opportunity is making your business easier for their agents to
                  order from.
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
                  <a
                    href={adobeSource}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Adobe Digital Insights, April 16, 2026 <Arrow diagonal />
                  </a>
                  . Measures AI-referred visits to U.S. retail sites, not
                  autonomous purchases or x402 volume.
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
                  U.S. retail · March 2026 · Adobe. Purchases after a visit to a
                  retailer’s website, not checkout inside an AI chat. This does
                  not establish demand for x402 orders.
                </span>
              </p>
              <a href={adobeSource} target="_blank" rel="noopener noreferrer">
                Read the research <Arrow diagonal />
              </a>
            </div>
          </div>
        </section>

        <section
          id="how-it-works"
          className={`${styles.container} ${styles.section}`}
        >
          <p className={styles.eyebrow}>02 / From cabinet to catalog</p>
          <div className={styles.sectionHeading}>
            <h2>
              A new channel.
              <br />A familiar business.
            </h2>
            <p>
              One email link opens the cabinet. A supported integration carries
              the offers and order rules agents can rely on.
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
                Enter your email and use the one-time link. The first visit
                creates your merchant and asks for the name buyers will see.
              </p>
              <span className={styles.stepOutput}>
                One address. One private cabinet.
              </span>
            </article>
            <article>
              <span className={styles.stepNumber}>02</span>
              <div className={styles.stepSymbol} aria-hidden="true">
                ⇄
              </div>
              <h3>Connect your catalog.</h3>
              <p>
                Use the <a href="/docs/quickstart">SDK</a> to publish the offer,
                price and fulfilment promises. The WooCommerce connector is
                experimental.
              </p>
              <span className={styles.stepOutput}>
                Catalog. Ordering. Confirmation.
              </span>
            </article>
            <article>
              <span className={styles.stepNumber}>03</span>
              <div className={styles.stepSymbol} aria-hidden="true">
                ✓
              </div>
              <h3>Prove it in test.</h3>
              <p>
                Test publication needs the seller name and test payout wallet.
                Live publication uses a separate wallet and also needs the
                operator’s approval for that merchant.
              </p>
              <span className={styles.stepOutput}>
                Test first. Live only when ready.
              </span>
            </article>
          </div>
          <div className={styles.protocols}>
            <p>Built around open agent commerce.</p>
            <span>x402</span>
            <span>Agent discovery</span>
            <span>Merchant integrations</span>
            <a
              href="https://docs.cdp.coinbase.com/x402/welcome"
              target="_blank"
              rel="noopener noreferrer"
            >
              About x402 <Arrow diagonal />
            </a>
          </div>
        </section>

        <section className={styles.settlement}>
          <div className={`${styles.container} ${styles.settlementGrid}`}>
            <div>
              <p className={styles.eyebrow}>03 / Payment in the live channel</p>
              <h2>
                Set your payout wallet.
                <br />
                <span>Keep test and live distinct.</span>
              </h2>
              <p>
                Live purchases use supported crypto payment and settle to the
                payout wallet in your cabinet. Agentify does not convert that
                payment into a bank payout. The test channel remains available
                before live publication is approved.
              </p>
              <a className={styles.textLink} href="/cabinet/sign-in">
                Open your cabinet <Arrow />
              </a>
            </div>
            <div
              className={styles.paymentDiagram}
              role="group"
              aria-label="Live payment path: customer agent, x402 payment facilitator, merchant payout wallet."
            >
              <div className={styles.paymentLabel}>
                LIVE ONLY AFTER OPERATOR APPROVAL
              </div>
              <div className={styles.paymentRow}>
                <span className={styles.nodeIcon}>01</span>
                <div>
                  <strong>Customer’s agent</strong>
                  <span>Supported x402 payment</span>
                </div>
                <span aria-hidden="true">↓</span>
              </div>
              <div className={styles.paymentRow}>
                <span className={styles.nodeIcon}>02</span>
                <div>
                  <strong>Payment facilitator</strong>
                  <span>Verifies and settles the supported token</span>
                </div>
                <span aria-hidden="true">↓</span>
              </div>
              <div className={styles.paymentRow}>
                <span className={styles.nodeIcon}>03</span>
                <div>
                  <strong>Merchant payout wallet</strong>
                  <span>The address set in your cabinet</span>
                </div>
                <span aria-hidden="true">✓</span>
              </div>
              <p>
                A seller name, payout wallet and operator approval are separate
                live-publication gates. Opening a cabinet grants none of them.
              </p>
            </div>
          </div>
        </section>

        <section
          className={`${styles.container} ${styles.section}`}
          id="loyalty"
          aria-labelledby="loyalty-title"
        >
          <p className={styles.eyebrow}>
            04 / Agent loyalty · Proposed program
          </p>
          <div className={styles.sectionHeading}>
            <h2 id="loyalty-title">Reward the customer behind the agent.</h2>
            <p>
              Give their agent a reason to choose your business again: clear
              cashback terms and a track record of delivering what you promise.
            </p>
          </div>
          <div className={styles.steps}>
            <article>
              <span className={styles.stepSymbol} aria-hidden="true">
                01
              </span>
              <h3>You fund the reward.</h3>
              <p>
                After merchant verification, agree a cashback rate, budget and
                return rules. Agents can read the offer and compare its value
                for their customer.
              </p>
            </article>
            <article>
              <span className={styles.stepSymbol} aria-hidden="true">
                02
              </span>
              <h3>Delivery unlocks it.</h3>
              <p>
                Cashback becomes payable to the customer only after verified
                delivery of the product or service, under the agreed terms.
                Payment alone does not trigger a reward.
              </p>
            </article>
            <article>
              <span className={styles.stepSymbol} aria-hidden="true">
                03
              </span>
              <h3>Reliability earns trust.</h3>
              <p>
                Delivery success, service quality and refund speed build a
                record that agents can weigh alongside price and cashback.
              </p>
            </article>
          </div>
          <div className={styles.localNote}>
            <p>
              <strong>A loyalty model we’re developing.</strong> Reward funding
              and refund reserves would be accounted for separately. Program
              terms and availability must be agreed before activation.
            </p>
            <a href="/cabinet/sign-in">
              Open your cabinet <Arrow diagonal />
            </a>
          </div>
        </section>

        <section
          className={`${styles.container} ${styles.section}`}
          id="businesses"
        >
          <p className={styles.eyebrow}>05 / More than an online store</p>
          <div className={styles.sectionHeading}>
            <h2>
              If people can buy it,
              <br />
              let’s explore an agent offer.
            </h2>
            <p>
              From a digital product to a day in Bali. We start with a specific
              service, a supported market and a process that can actually fulfil
              the order.
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
          <div className={styles.localNote}>
            <span className={styles.localMark} aria-hidden="true">
              ↗
            </span>
            <p>
              <strong>Local business. Agent-ready offer.</strong> A restaurant
              table, a coworking pass or a hotel stay can be the starting point.
              Local availability and payment rules always shape the setup.
            </p>
            <a href="/cabinet/sign-in">
              Open your cabinet <Arrow diagonal />
            </a>
          </div>
        </section>

        <section className={styles.entry} id="start">
          <div className={`${styles.container} ${styles.entryGrid}`}>
            <div>
              <p className={styles.eyebrow}>06 / Your cabinet starts here</p>
              <h2>
                Start with
                <br />
                your email.
              </h2>
              <p>
                The one-time link signs you in or creates your cabinet. No
                password, invitation code or application review stands between
                your address and the test channel.
              </p>
              <ul>
                <li>Choose the seller name buyers see</li>
                <li>
                  Integrate through the{" "}
                  <a href="/docs/quickstart">Agentify SDK</a>
                </li>
                <li>Publish and verify offers in the test channel</li>
              </ul>
              <div className={styles.entryNote}>
                Live publication still needs a payout wallet and a one-time
                operator approval for the merchant.
              </div>
            </div>
            <div className={styles.entryCard}>
              <p className={styles.eyebrow}>Merchant cabinet</p>
              <h3>Open the door from your inbox.</h3>
              <p>
                Enter your email in the cabinet. The message works once and
                expires after one hour.
              </p>
              <a className={styles.primary} href="/cabinet/sign-in">
                Open your cabinet <Arrow diagonal />
              </a>
              <p className={styles.entryFootnote}>
                The mailbox is the key to the cabinet. A shared mailbox means a
                shared cabinet.
              </p>
            </div>
          </div>
        </section>

        <section id="questions" className={`${styles.container} ${styles.faq}`}>
          <div>
            <p className={styles.eyebrow}>A few things worth knowing</p>
            <h2>
              Good questions.
              <br />
              Straight answers.
            </h2>
          </div>
          <div>
            {questions.map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.container}>
          <Link className={styles.brand} href="/">
            <BrandMark className={styles.mark} />
            <span>Agentify</span>
          </Link>
          <p>
            Ordinary businesses.
            <br />
            An extraordinary next chapter.
          </p>
          <div>
            <a href="/privacy">Privacy</a>
            <a href="#questions">Merchant questions</a>
            <span>© {new Date().getFullYear()} Agentify</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
