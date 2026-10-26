import { PrivacyChoicesButton } from "@agentify/consent";
import {
  SiteDoors as Doors,
  SiteFooter as Footer,
  SiteHeader as Header,
  SiteMenu as Menu,
} from "@agentify/ui";
import type { ReactNode } from "react";
import { Brand } from "./brand";
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
      <div className={`${styles.row} container`}>
        <Brand />
        {end === undefined ? <SiteDoors /> : end}
      </div>
    </header>
  );
}

/**
 * The site footer as the scanner draws it: its own pages followed in place,
 * then `children`, the links only this page needs, and the privacy choices.
 */
export function SiteFooter({ children }: Readonly<{ children?: ReactNode }>) {
  return (
    <Footer surface="scanner" link={SiteLink}>
      {children}
      <PrivacyChoicesButton className="foot-action" />
    </Footer>
  );
}
