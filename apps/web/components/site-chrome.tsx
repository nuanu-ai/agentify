import Link from "next/link";

import { getPublicAppConfig } from "../lib/app-config";
import { Brand } from "./brand";
import { PrivacyChoicesButton } from "./privacy-choices-button";
import styles from "./site-chrome.module.css";
import { VisitorDoor } from "./visitor-door";

/**
 * The two doors out of the scanner, the documentation and the dashboard, and
 * who is signed in.
 *
 * Both destinations are other processes on the same origin, not routes of this
 * application, so they are plain anchors rather than the router's links. When
 * the bar runs out of room the section links go, never these: the stylesheet
 * hides the nav by steps and lets the doors wrap down to 320px.
 */
export function SiteDoors() {
  return (
    <nav aria-label="Docs, dashboard and your session" className={styles.doors}>
      <a href="/docs/">Docs</a>
      <a href="/dashboard/sign-in">Dashboard</a>
      <VisitorDoor />
    </nav>
  );
}

export function MarketingHeader() {
  return (
    <header className={styles.header}>
      <a className="skip" href="#main">
        Skip to content
      </a>
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
          <Link href="/store">For stores</Link>
          <Link href="/local">For local</Link>
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
