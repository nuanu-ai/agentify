import textFont from "@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2?url";
import { Fragment } from "react";
import { type MetaArgs, useLoaderData } from "react-router";

import { SiteFooter, SiteHeader } from "../../components/site-chrome";
import { AGENTIC_SHOP, numbered } from "../../content/agentic-shop";
import { SELL_TO_AGENTS_PICTURE } from "../../content/pictures";
import type { RichText } from "../../content/public-editorial";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";
import styles from "./agentic-shop.module.css";

export const links = () => [
  { rel: "preload", href: textFont, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
];

export const loader = () => AGENTIC_SHOP;

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), {
    title: AGENTIC_SHOP.head.title,
    description: AGENTIC_SHOP.head.description,
    canonical: "/agentic-shop",
    card: {
      title: AGENTIC_SHOP.head.cardTitle,
      description: AGENTIC_SHOP.head.cardDescription,
      image: SELL_TO_AGENTS_PICTURE,
      addressed: true,
    },
  });

/** The still life at the widths a phone, a laptop and a sharp screen ask for. */
const HERO = {
  src: "/agentic-shop/merchant-still-life-1448.webp",
  srcSet: [640, 1080, 1448]
    .map((width) => `/agentic-shop/merchant-still-life-${width}.webp ${width}w`)
    .join(", "),
  sizes: "(max-width: 800px) calc(100vw - 40px), 50vw",
};

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <span aria-hidden="true">{diagonal ? "↗" : "→"}</span>;
}

/** The words alone, links read as their text. */
const plain = (of: RichText): string =>
  typeof of === "string" ? of : of.map((node) => node.value).join("");

/** Words with the links inside them; every link leads off this page. */
function Words({ of }: Readonly<{ of: RichText }>) {
  if (typeof of === "string") return of;
  return of.map((node) =>
    node.kind === "link" ? (
      <a href={node.href} key={`link:${node.value}`}>
        {node.value}
      </a>
    ) : (
      <Fragment key={`text:${node.value}`}>{node.value}</Fragment>
    ),
  );
}

/** A title's lines, the last drawn in the accent where `accent` says so. */
function Lines({ of, accent = false }: Readonly<{ of: readonly string[]; accent?: boolean }>) {
  return of.map((line, index) =>
    index === of.length - 1 ? (
      accent ? (
        <span key={line}>{line}</span>
      ) : (
        line
      )
    ) : (
      <Fragment key={line}>
        {line}
        <br />
      </Fragment>
    ),
  );
}

export default function AgenticShopPage() {
  const { hero, promise, opportunity, how, payment, loyalty, businesses, start, questions } =
    useLoaderData<typeof loader>();
  const { research } = opportunity;
  return (
    <>
      <SiteHeader />
      <main className={styles.page} id="main">
        <section className={`container ${styles.hero}`}>
          <div>
            <p className={styles.eyebrow}>
              <span className={styles.dot} /> {hero.eyebrow}
            </p>
            <h1>
              <Lines of={hero.title} accent />
            </h1>
            <p className={styles.heroDescription}>{hero.description}</p>
            <div className={styles.heroActions}>
              <a className={styles.primary} href="/dashboard/sign-in">
                {hero.action} <Arrow diagonal />
              </a>
              <a className={styles.textLink} href="#how-it-works">
                {hero.howItWorks} <Arrow />
              </a>
            </div>
            <p className={styles.heroNote}>{hero.note}</p>
          </div>
          <div className={styles.heroVisual}>
            <img
              alt={hero.imageAlt}
              className={styles.heroImage}
              decoding="async"
              height={1086}
              sizes={HERO.sizes}
              src={HERO.src}
              srcSet={HERO.srcSet}
              width={1448}
            />
          </div>
        </section>

        <div className={`container ${styles.promiseStrip}`}>
          <p>
            {promise.lead}
            <br />
            <strong>{promise.strong}</strong>
          </p>
          {promise.items.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>

        <section className={styles.opportunity} id="opportunity">
          <div className="container">
            <div className={styles.marketGrid}>
              <div className={styles.marketCopy}>
                <h2>
                  <Lines of={opportunity.title} accent />
                </h2>
                <p>{opportunity.text}</p>
                <a href="/dashboard/sign-in" className={styles.lightLink}>
                  {opportunity.action} <Arrow diagonal />
                </a>
              </div>
              <div className={styles.chartCard}>
                <div className={styles.chartHeading}>
                  {opportunity.chartHeading.map((words) => (
                    <span key={words}>{words}</span>
                  ))}
                </div>
                <div className={styles.growth}>
                  <strong>
                    +{research.traffic.growthPercent}
                    <span>%</span>
                  </strong>
                  <p>
                    <Lines of={opportunity.growth} />
                  </p>
                </div>
                <figure className={styles.chart} aria-label={opportunity.chartLabel}>
                  <div className={styles.chartLines} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className={styles.barColumn}>
                    <span>{research.traffic.baselineIndex}</span>
                    <div className={styles.barOld} />
                    <b>{opportunity.bars[0]}</b>
                  </div>
                  <div className={styles.barColumn}>
                    <span>{research.traffic.comparisonIndex}</span>
                    <div className={styles.barNew} />
                    <b>{opportunity.bars[1]}</b>
                  </div>
                  <figcaption>{opportunity.chartCaption}</figcaption>
                </figure>
                <p className={styles.source}>
                  Source:{" "}
                  <a href={research.sourceUrl} target="_blank" rel="noopener noreferrer">
                    {opportunity.source} <Arrow diagonal />
                  </a>
                  . {opportunity.sourceScope}
                </p>
              </div>
            </div>
            <div className={styles.marketBottom}>
              <strong>
                +{research.conversion.relativeLiftPercent}
                <span>%</span>
              </strong>
              <p>
                {opportunity.conversion}
                <span>{opportunity.conversionScope}</span>
              </p>
              <a href={research.sourceUrl} target="_blank" rel="noopener noreferrer">
                {opportunity.readMore} <Arrow diagonal />
              </a>
            </div>
          </div>
        </section>

        <section id="how-it-works" className={`container ${styles.section}`}>
          <div className={styles.sectionHeading}>
            <h2>
              <Lines of={how.title} />
            </h2>
            <p>{how.lede}</p>
          </div>
          {/* biome-ignore lint/a11y/noRedundantRoles: Safari needs the role when CSS hides list markers. */}
          <ol className={styles.steps} role="list">
            {how.steps.map((step, index) => (
              <li key={step.title}>
                <span className={styles.stepNumber} aria-hidden="true">
                  {numbered(index)}
                </span>
                <div className={styles.stepSymbol} aria-hidden="true">
                  {step.symbol}
                </div>
                <h3>{step.title}</h3>
                <p>
                  <Words of={step.text} />
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.settlement}>
          <div className={`container ${styles.settlementGrid}`}>
            <div>
              <h2>
                <Lines of={payment.title} accent />
              </h2>
              <p>{payment.text}</p>
              <div className={styles.settlementLinks}>
                <a className={styles.textLink} href="/dashboard/sign-in">
                  {payment.action} <Arrow />
                </a>
                <a className={styles.textLink} href={payment.more.href}>
                  {payment.more.label} <Arrow />
                </a>
              </div>
            </div>
            <section className={styles.paymentDiagram} aria-label={payment.path.label}>
              <div className={styles.paymentLabel}>{payment.path.top}</div>
              {payment.path.steps.map(([title, text], index) => (
                <div className={styles.paymentRow} key={title}>
                  <span className={styles.nodeIcon}>{numbered(index)}</span>
                  <div>
                    <strong>{title}</strong>
                    <span>{text}</span>
                  </div>
                  <span aria-hidden="true">
                    {index === payment.path.steps.length - 1 ? "✓" : "↓"}
                  </span>
                </div>
              ))}
            </section>
          </div>
        </section>

        <div className="container" id="loyalty">
          <p className={styles.soon}>{loyalty}</p>
        </div>

        <section className={`container ${styles.section}`} id="businesses">
          <div className={styles.sectionHeading}>
            <h2>
              <Lines of={businesses.title} />
            </h2>
            <p>{businesses.lede}</p>
          </div>
          <div className={styles.categories}>
            {businesses.categories.map((category, index) => (
              <article key={category.title}>
                <span>{numbered(index)}</span>
                <h3>{category.title}</h3>
                <p>{category.text}</p>
                <small>{category.examples}</small>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.entry} id="start">
          <div className={`container ${styles.entryGrid}`}>
            <div>
              <h2>
                <Lines of={start.title} />
              </h2>
              <p>{start.text}</p>
              <ul>
                {start.steps.map((step) => (
                  <li key={plain(step)}>
                    <Words of={step} />
                  </li>
                ))}
              </ul>
            </div>
            <div className={styles.entryCard}>
              <h3>{start.card.title}</h3>
              <p>{start.card.text}</p>
              <a className={styles.primary} href="/dashboard/sign-in">
                {start.card.action} <Arrow diagonal />
              </a>
              <p className={styles.entryFootnote}>{start.card.footnote}</p>
            </div>
          </div>
        </section>

        <section className={`container ${styles.section}`} id="questions">
          <div className={styles.sectionHeading}>
            <h2>{questions.title}</h2>
            <p>
              <Words of={questions.text} />
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
