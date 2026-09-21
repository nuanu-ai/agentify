import Link from "next/link";
import React from "react";

import { getPublicAppConfig } from "../lib/app-config";
import { Brand } from "./brand";
import { PrivacyChoicesButton } from "./privacy-choices-button";
import styles from "./site-chrome.module.css";

export function MarketingHeader() {
  return (
    <header className={styles.header}>
      <div className={`${styles.headerInner} container`}>
        <Brand />
        <nav aria-label="Primary" className={styles.nav}>
          <Link href="/agentic-shop">Agentic Shop</Link>
          <Link href="/scanner">Scanner</Link>
          <Link href="/methodology">Methodology</Link>
          <Link href="/privacy">Privacy</Link>
        </nav>
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
          <Link href="/agentic-shop">Agentic Shop</Link>
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
