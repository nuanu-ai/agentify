import Link from "next/link";
import React, { type ReactNode } from "react";

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
      <div className={`${styles.footerGrid} container`}>
        <div className={styles.footerIntro}>
          <Brand inverse />
          <p>
            A diagnostic for public, machine-readable website signals. We do not
            modify sites or test a particular model&apos;s answer.
          </p>
        </div>
        <FooterGroup title="Segments">
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
