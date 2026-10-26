import { PrivacyChoicesButton } from "@agentify/consent";
import { type Current, SiteFooter as Footer, SiteHeader as Header, useVisitor } from "@agentify/ui";
import type { ReactNode } from "react";
import { SiteLink } from "./site-link";

/**
 * The site's bar as the scanner draws it: its own pages followed in place,
 * with who is visiting, which the browser asks for since the page is the same
 * for everybody. `current` is the part of the site the page belongs to.
 */
export function SiteHeader({
  current,
}: Readonly<{ current?: Extract<Current, "scanner" | "sell"> }>) {
  return <Header surface="scanner" link={SiteLink} current={current} visitor={useVisitor()} />;
}

/** Where a page stands under another, the first line of its message panel: `parent` leads there, `page` is this one. */
export function Trail({
  parent,
  page,
}: Readonly<{ parent: readonly [string, string]; page: string }>) {
  const [label, to] = parent;
  return (
    <nav aria-label="Breadcrumb" className="message-meta trail">
      <SiteLink to={to}>{label}</SiteLink>
      <span aria-current="page">{page}</span>
    </nav>
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
