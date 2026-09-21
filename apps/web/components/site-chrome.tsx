import Link from "next/link";
import React, { type ReactNode } from "react";

import { getPublicAppConfig } from "../lib/app-config";
import { Brand } from "./brand";
import { PrivacyChoicesButton } from "./privacy-choices-button";
import styles from "./site-chrome.module.css";

/**
 * The two doors out of the scanner: the documentation and the cabinet.
 *
 * Both destinations are other processes on the same origin (ADR-0005 §1),
 * not routes of this application, so they are plain anchors and not the
 * router's links. The words are the ones the destinations use of themselves:
 * the portal says "Docs" in its own corner, and the cabinet's sign-in page
 * says what one link does before anybody presses it. The landing and the
 * trust headers both render this element, so a merchant who typed the site's
 * name into a browser has a way in that is not memory
 * (docs/research/31-user-journey.md). When the bar runs out of room it is the
 * section links that go, never these two: the stylesheet hides the nav by
 * steps and keeps the doors at every width down to 320px.
 */
export function SiteDoors() {
  return (
    <nav aria-label="Docs and cabinet" className={styles.doors}>
      <a href="/docs/">Docs</a>
      <a href="/cabinet/sign-in">Cabinet</a>
    </nav>
  );
}

export function MarketingHeader() {
  return (
    <header className={styles.header}>
      <div className={`${styles.headerInner} container`}>
        <Brand />
        <div className={styles.headerLinks}>
          <nav aria-label="Primary" className={styles.nav}>
            <Link href="/agentic-shop">Agentic Shop</Link>
            <Link href="/scanner">Scanner</Link>
            <Link href="/methodology">Methodology</Link>
            <Link href="/privacy">Privacy</Link>
          </nav>
          <SiteDoors />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const config = getPublicAppConfig();

  return (
    <footer className={styles.footer}>
      <div className={`${styles.footerGrid} container`}>
        <div className={styles.footerIntro}>
          <Brand inverse />
          <p>
            A diagnostic for public, machine-readable website signals. We do not
            modify sites or test a particular model&apos;s answer.
          </p>
        </div>
        <FooterGroup title="Segments">
          <Link href="/agentic-shop">For merchants</Link>
          <Link href="/owner">For owners</Link>
          <Link href="/store">For stores</Link>
          <Link href="/local">For local</Link>
        </FooterGroup>
        <FooterGroup title="Trust">
          <Link href="/scanner">The scanner</Link>
          <Link href="/methodology">Methodology</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </FooterGroup>
        <FooterGroup title="Control">
          <Link href="/data-request">Data request</Link>
          <PrivacyChoicesButton className={styles.footerAction} />
          <a href={`mailto:${config.abuseEmail}`}>Report abuse</a>
        </FooterGroup>
      </div>
      <div className={`${styles.footerBottom} container`}>
        <span>
          Scanner UA: {config.scannerUserAgent.split(" ")[0]} · public HTTP only
        </span>
        <span>© 2026 {config.displayBrand}</span>
      </div>
    </footer>
  );
}

function FooterGroup({
  children,
  title,
}: Readonly<{ children: ReactNode; title: string }>) {
  return (
    <div className={styles.footerGroup}>
      <span>{title}</span>
      {children}
    </div>
  );
}
