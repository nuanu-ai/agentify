import Link from "next/link";

import {
  LANDING_EXAMPLE_CHECKS,
  LANDING_SHARED_CONTENT,
  type LandingConfig,
} from "../content/landing";
import { LANDING_SEGMENT_ATTRIBUTE, LANDING_VARIANT_ATTRIBUTE } from "../lib/landing-announcement";
import { publicSiteSchema } from "../lib/schema";
import styles from "./landing-page.module.css";
import { MarketingHeader, SiteFooter } from "./site-chrome";
import { StatusBadge } from "./status-badge";
import { StructuredData } from "./structured-data";
import { UrlScanForm } from "./url-scan-form";

export function LandingPage({ config }: Readonly<{ config: LandingConfig }>) {
  return (
    <>
      <StructuredData schema={publicSiteSchema()} />
      <MarketingHeader />
      <main
        id="main"
        {...{
          [LANDING_SEGMENT_ATTRIBUTE]: config.segment,
          [LANDING_VARIANT_ATTRIBUTE]: config.variant,
        }}
      >
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
              {config.secondDoor ? (
                <p className={styles.secondDoor}>
                  {config.secondDoor.lead}{" "}
                  <Link href={config.secondDoor.href}>{config.secondDoor.label} →</Link>
                </p>
              ) : null}
            </div>
            <ExampleSurface segmentPhase={config.segmentPhase} />
          </div>
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
              <h3>{LANDING_SHARED_CONTENT.reportHeading}</h3>
              <Link href="/methodology">{LANDING_SHARED_CONTENT.reportMethodologyLink}</Link>
            </div>
            <div className={styles.exampleChecks}>
              {LANDING_EXAMPLE_CHECKS.map((check) => (
                <div className={styles.exampleCheck} key={check.checkId}>
                  <span>{check.name}</span>
                  <StatusBadge status={check.status} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.finalCta} container`}>
          <h2>{LANDING_SHARED_CONTENT.finalCta}</h2>
          <UrlScanForm cta={config.hero.cta} segment={config.segment} variant={config.variant} />
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
        <span>Example · example.com</span>
        <StatusBadge status="running" />
      </div>
      <div className={styles.surfaceRows}>
        <SurfaceRow label="robots.txt and sitemap" status="pass" />
        <SurfaceRow label="Structured data" status="partial" />
        <SurfaceRow label="Agent-readable output" status="pass" />
        <SurfaceRow label={segmentPhase} status="running" />
        <SurfaceRow label="Diagnostic report" status="pending" />
      </div>
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
