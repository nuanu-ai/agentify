import Link from "next/link";
import React from "react";

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
            <Link href="/agentic-shop">Sell to agents</Link>
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
      <div className={`${styles.footerRow} container`}>
        <Brand inverse />
        <nav aria-label="Site" className={styles.footerLinks}>
          <Link href="/agentic-shop">Sell to agents</Link>
          <Link href="/scanner">Scanner</Link>
          <Link href="/methodology">Methodology</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/data-request">Data request</Link>
          <PrivacyChoicesButton className={styles.footerAction} />
          <a href={`mailto:${config.abuseEmail}`}>Report abuse</a>
        </nav>
        <span className={styles.copyright}>© 2026 {config.displayBrand}</span>
      </div>
    </footer>
  );
}
