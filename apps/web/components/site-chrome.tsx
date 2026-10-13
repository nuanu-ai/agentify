import { Brand } from "./brand";
import { PrivacyChoicesButton } from "./privacy-choices-button";
import { usePublicConfig } from "./public-config";
import styles from "./site-chrome.module.css";
import { SiteLink } from "./site-link";
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
            <SiteLink to="/agentic-shop">Sell to agents</SiteLink>
            <SiteLink to="/scanner">Scanner</SiteLink>
            <SiteLink to="/methodology">Methodology</SiteLink>
            <SiteLink to="/privacy">Privacy</SiteLink>
          </nav>
          <SiteDoors />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const config = usePublicConfig();

  return (
    <footer className={styles.footer}>
      <div className={`${styles.footerRow} container`}>
        <Brand inverse />
        <nav aria-label="Site" className={styles.footerLinks}>
          <SiteLink to="/agentic-shop">Sell to agents</SiteLink>
          <SiteLink to="/store">For stores</SiteLink>
          <SiteLink to="/local">For local</SiteLink>
          <SiteLink to="/scanner">Scanner</SiteLink>
          <SiteLink to="/methodology">Methodology</SiteLink>
          <SiteLink to="/privacy">Privacy</SiteLink>
          <SiteLink to="/terms">Terms</SiteLink>
          <SiteLink to="/data-request">Data request</SiteLink>
          <PrivacyChoicesButton className={styles.footerAction} />
          <a href={`mailto:${config.abuseEmail}`}>Report abuse</a>
        </nav>
        <span className={styles.copyright}>© 2026 {config.displayBrand}</span>
      </div>
    </footer>
  );
}
