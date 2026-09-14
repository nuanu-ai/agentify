import Link from "next/link";

import {
  LANDING_EXAMPLE_CHECKS,
  LANDING_SHARED_CONTENT,
  type LandingConfig,
} from "../content/landing";
import { getSource } from "../content/sources";
import { publicSiteSchema } from "../lib/schema";
import { StatusBadge } from "./status-badge";
import { StructuredData } from "./structured-data";
import { MarketingHeader, SiteFooter } from "./site-chrome";
import { UrlScanForm } from "./url-scan-form";
import styles from "./landing-page.module.css";

export function LandingPage({ config }: Readonly<{ config: LandingConfig }>) {
  return (
    <>
      <StructuredData schema={publicSiteSchema()} />
      <MarketingHeader />
      <main>
        <section className={`${styles.hero} container`}>
          <div className={styles.heroGrid}>
            <div className={styles.heroCopy}>
              <div className="eyebrow">{config.eyebrow}</div>
              <h1>{config.hero.title}</h1>
              <p>{config.hero.subtitle}</p>
              <UrlScanForm
                cta={config.hero.cta}
                segment={config.segment}
                variant={config.variant}
              />
              <div className={styles.assurances}>
                {LANDING_SHARED_CONTENT.assurances.map((assurance) => (
                  <span key={assurance}>{assurance}</span>
                ))}
              </div>
            </div>
            <ExampleSurface segmentPhase={config.segmentPhase} />
          </div>
        </section>

        <section className={`${styles.pains} container`}>
          <div className="eyebrow">Why it matters</div>
          <div className={styles.painGrid}>
            {config.pains.map((pain, painIndex) => (
              <article className={styles.painCard} key={pain.title}>
                <h2>{pain.title}</h2>
                <p>{pain.body}</p>
                <div className={styles.sources}>
                  {pain.sourceIds.map((sourceId) => {
                    const source = getSource(sourceId);
                    return (
                      <a
                        href={source.url}
                        key={source.id}
                        rel="noreferrer"
                        target="_blank"
                      >
                        [{painIndex + 1}] {source.publisher} ·{" "}
                        {source.evidenceClass.toLowerCase()}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    );
                  })}
                </div>
              </article>
            ))}
          </div>
          <ol className={styles.footnotes}>
            {config.pains.map((pain, index) => {
              const firstSourceId = pain.sourceIds[0];
              if (!firstSourceId) return null;
              const source = getSource(firstSourceId);
              return (
                <li key={`${source.id}-${index}`}>
                  <a href={source.url} rel="noreferrer" target="_blank">
                    [{index + 1}] {source.title}
                  </a>
                  . {source.caveat}
                </li>
              );
            })}
          </ol>
        </section>

        <section className={styles.how} id="how">
          <div className="container">
            <h2>{LANDING_SHARED_CONTENT.howTitle}</h2>
            <div className={styles.steps}>
              {LANDING_SHARED_CONTENT.howSteps.map((step) => (
                <Step index={step.index} key={step.index} title={step.title}>
                  {step.body}
                </Step>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.report} container`} id="report">
          <div className={styles.reportHeading}>
            <h2>{LANDING_SHARED_CONTENT.reportTitle}</h2>
            <span>{LANDING_SHARED_CONTENT.reportLabel}</span>
          </div>
          <div className={styles.reportCard}>
            <div className={styles.reportIntro}>
              <div className="eyebrow">
                {LANDING_SHARED_CONTENT.reportEyebrow}
              </div>
              <h3>{LANDING_SHARED_CONTENT.reportHeading}</h3>
              <p>{LANDING_SHARED_CONTENT.reportBody}</p>
              <Link href="/methodology">
                {LANDING_SHARED_CONTENT.reportMethodologyLink}
              </Link>
            </div>
            <div className={styles.exampleChecks}>
              {LANDING_EXAMPLE_CHECKS.map((check) => (
                <div className={styles.exampleCheck} key={check.checkId}>
                  <span>
                    <span className="mono">#{check.checkId}</span> {check.name}
                  </span>
                  <StatusBadge status={check.status} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.faq} id="faq">
          <div className="container">
            <h2>{LANDING_SHARED_CONTENT.faqTitle}</h2>
            {config.faq.map((item) => (
              <details key={item.question}>
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={`${styles.finalCta} container`}>
          <h2>{LANDING_SHARED_CONTENT.finalCta}</h2>
          <UrlScanForm
            compact
            cta={config.hero.cta}
            segment={config.segment}
            variant={config.variant}
          />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function ExampleSurface({ segmentPhase }: Readonly<{ segmentPhase: string }>) {
  return (
    <div aria-label="Example of scanner phases" className={styles.surface}>
      <div className={styles.surfaceHeader}>
        <span>example.com</span>
        <StatusBadge status="running" />
      </div>
      <div className={styles.surfaceRows}>
        <SurfaceRow label="robots.txt and sitemap" status="pass" />
        <SurfaceRow label="Structured data" status="partial" />
        <SurfaceRow label="Agent-readable output" status="pass" />
        <SurfaceRow label={segmentPhase} status="running" />
        <SurfaceRow label="Diagnostic report" status="pending" />
      </div>
      <p>Example surface · real scans show real backend states</p>
    </div>
  );
}

function SurfaceRow({
  label,
  status,
}: Readonly<{
  label: string;
  status: "pass" | "partial" | "running" | "pending";
}>) {
  return (
    <div className={styles.surfaceRow}>
      <span>{label}</span>
      <StatusBadge status={status} />
    </div>
  );
}

function Step({
  children,
  index,
  title,
}: Readonly<{ children: string; index: string; title: string }>) {
  return (
    <article>
      <span>{index}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}
