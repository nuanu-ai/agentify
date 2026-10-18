import { PrivacyChoicesButton } from "@agentify/consent";
import { SiteDoors as Doors, SiteHeader as Header, SiteMenu as Menu } from "@agentify/ui";
import type { ReactNode } from "react";
import { Brand } from "./brand";
import { usePublicConfig } from "./public-config";
import styles from "./site-chrome.module.css";
import { SiteLink } from "./site-link";
import { VisitorDoor } from "./visitor-door";

/** The site header as the scanner draws it: its own pages followed in place, with who is visiting. */
export function SiteHeader() {
  return (
    <Header
      surface="scanner"
      link={SiteLink}
      visitor={<VisitorDoor />}
      menu={<Menu surface="scanner" link={SiteLink} visitor={<VisitorDoor />} />}
    />
  );
}

/** The header's doors and its menu, for the end of a page's own top, beside the lockup. */
export function SiteDoors() {
  return (
    <div className="site-top-end">
      <Doors surface="scanner" link={SiteLink} visitor={<VisitorDoor />} />
      <Menu surface="scanner" link={SiteLink} visitor={<VisitorDoor />} />
    </div>
  );
}

/**
 * The top of a scan's, a report's and a published result's page: the lockup
 * and the doors with who is visiting, over a hairline, without the site's
 * sections the landing pages' header lists. `end` stands in for the doors on
 * a page that offers none, and `null` leaves the end empty.
 */
export function SiteTop({ end }: Readonly<{ end?: ReactNode }>) {
  return (
    <header className={styles.top}>
      <Brand />
      {end === undefined ? <SiteDoors /> : end}
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
          <a href="/docs/scanner">Scanner</a>
          <a href="/docs/scanner/methodology">Methodology</a>
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
