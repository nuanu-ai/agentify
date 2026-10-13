import { SiteDoors as Doors, SiteHeader as Header } from "@agentify/ui";
import { Brand } from "./brand";
import { PrivacyChoicesButton } from "./privacy-choices-button";
import { usePublicConfig } from "./public-config";
import styles from "./site-chrome.module.css";
import { SiteLink } from "./site-link";
import { VisitorDoor } from "./visitor-door";

/** The site header as the scanner draws it: its own pages followed in place, with who is visiting. */
export function SiteHeader() {
  return <Header surface="scanner" link={SiteLink} visitor={<VisitorDoor />} />;
}

/** The header's doors alone, for a page that lays out its own top. */
export function SiteDoors() {
  return <Doors surface="scanner" link={SiteLink} visitor={<VisitorDoor />} />;
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
