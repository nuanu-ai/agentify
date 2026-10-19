/**
 * The two headers the surfaces draw at the top of their pages, the site
 * header over the public pages and the working header over the pages a
 * signed-in person works in, and the parts a surface places inside its own
 * layout: the lockup, a surface's sections and who is signed in with the way
 * out.
 *
 * The site is served by more than one process on one origin. A link to a page
 * the surface drawing it serves is that surface's own router link, followed
 * without a page load; a link to a page another process serves is a plain
 * anchor, because the router would look for it among its own pages and draw
 * the page that says there is none.
 */

import type { ComponentType, ReactNode } from "react";
import { Form, Link } from "react-router";
import { BrandMark } from "./mark.js";
import { HeaderMenu } from "./menu.js";

/** The surfaces that draw a header, each served apart from the others on the origin. */
export type Surface = "scanner" | "dashboard" | "docs";

/**
 * How a surface links to a page of its own: `to` is the page's path inside
 * the surface, as its router names it.
 */
type OwnLink = ComponentType<
  Readonly<{ to: string; className?: string; "aria-current"?: "true"; children: ReactNode }>
>;

/** Where on the origin each process answers. */
const MOUNTED_AT: Readonly<Record<Surface, string>> = {
  scanner: "",
  dashboard: "/dashboard",
  docs: "/docs",
};

/** A page on the origin: the surface that serves it and its path inside that surface. */
export type Place = Readonly<{ owner: Surface; path: string }>;

export const HOME: Place = { owner: "scanner", path: "/" };

const SECTIONS: readonly (Place & Readonly<{ label: string }>)[] = [
  { owner: "scanner", path: "/agentic-shop", label: "Sell to agents" },
  { owner: "docs", path: "/scanner", label: "Scanner" },
  { owner: "docs", path: "/scanner/methodology", label: "Methodology" },
  { owner: "scanner", path: "/privacy", label: "Privacy" },
];

const DOCS: Place = { owner: "docs", path: "/" };

/**
 * The dashboard's door: from elsewhere its sign-in, which sends somebody
 * already signed in on to their dashboard, and inside the dashboard its own
 * start.
 */
const DASHBOARD: Readonly<Record<Surface, Place>> = {
  scanner: { owner: "dashboard", path: "/sign-in" },
  dashboard: { owner: "dashboard", path: "/" },
  docs: { owner: "dashboard", path: "/sign-in" },
};

/** What every part of the header and the footer needs to draw a link: who draws it, and how it links home. */
export type Drawn = Readonly<{ surface: Surface; link: OwnLink }>;

/** `current` marks the link to the part of the site the page belongs to. */
export function PlaceLink({
  place,
  surface,
  link: Own,
  className,
  current = false,
  children,
}: Drawn & Readonly<{ place: Place; className?: string; current?: boolean; children: ReactNode }>) {
  if (place.owner === surface) {
    return (
      <Own className={className} to={place.path} aria-current={current ? "true" : undefined}>
        {children}
      </Own>
    );
  }
  return (
    <a className={className} href={`${MOUNTED_AT[place.owner]}${place.path}`}>
      {children}
    </a>
  );
}

/** The mark and the name, a link to the front page. */
export function BrandLockup({ home = "/" }: Readonly<{ home?: string }>) {
  return (
    <a className="brand" href={home}>
      <BrandMark className="brand-mark" />
      <span>Agentify</span>
    </a>
  );
}

function DocsDoor(drawn: Drawn) {
  return (
    <PlaceLink place={DOCS} current={drawn.surface === "docs"} {...drawn}>
      Docs
    </PlaceLink>
  );
}

/**
 * The doors out of the surface, the documentation and the dashboard, and who
 * is signed in, which the surface draws in `visitor` since each knows it its
 * own way. When the bar runs out of room the section links go, never these:
 * the doors wrap instead, and on a phone the signed-in address gives way to
 * keep them on one row.
 */
export function SiteDoors({ visitor, ...drawn }: Drawn & Readonly<{ visitor?: ReactNode }>) {
  return (
    <nav aria-label="Docs, dashboard and your session" className="site-doors">
      <DocsDoor {...drawn} />
      <PlaceLink
        place={DASHBOARD[drawn.surface]}
        current={drawn.surface === "dashboard"}
        {...drawn}
      >
        Dashboard
      </PlaceLink>
      {visitor}
    </nav>
  );
}

/**
 * The row both headers draw: the way past it first, then the lockup, a link
 * to the front page, at the row's start and `children` at its end. It stays
 * in view, and a menu at its end opens its panel under it.
 */
function Bar({
  className,
  children,
  ...drawn
}: Drawn & Readonly<{ className: string; children: ReactNode }>) {
  return (
    <header className={className}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="site-header-inner container">
        <PlaceLink className="brand" place={HOME} {...drawn}>
          <BrandMark className="brand-mark" />
          <span>Agentify</span>
        </PlaceLink>
        <div className="site-header-links">{children}</div>
      </div>
    </header>
  );
}

/**
 * The bar over the site's public pages: the lockup, the public site's
 * sections and the doors, then `menu` at the end of the row. `menu` is the
 * surface's `SiteMenu`, which lists every section the narrowing bar leaves
 * out; a bar drawn without one keeps to its row by dropping its section links
 * instead.
 */
export function SiteHeader({
  visitor,
  menu,
  ...drawn
}: Drawn & Readonly<{ visitor?: ReactNode; menu?: ReactNode }>) {
  return (
    <Bar className="site-header" {...drawn}>
      <nav aria-label="Primary" className="site-nav">
        {SECTIONS.map((section) => (
          <PlaceLink key={section.path} place={section} {...drawn}>
            {section.label}
          </PlaceLink>
        ))}
      </nav>
      <SiteDoors visitor={visitor} {...drawn} />
      {menu}
    </Bar>
  );
}

/**
 * The bar over the pages a signed-in person works in: the lockup, the
 * documentation and who is signed in with the way out, which the surface
 * draws in `visitor`, and none of the public site's sections or the door to
 * the dashboard. Where the bar has no room for them it shows none of them and
 * keeps the lockup and the menu's button, so `menu`, the surface's own, must
 * hold the documentation and `visitor` as well as the surface's sections.
 */
export function WorkHeader({
  visitor,
  menu,
  ...drawn
}: Drawn & Readonly<{ visitor: ReactNode; menu: ReactNode }>) {
  return (
    <Bar className="site-header work-header" {...drawn}>
      <nav aria-label="Docs and your session" className="site-doors">
        <DocsDoor {...drawn} />
        {visitor}
      </nav>
      {menu}
    </Bar>
  );
}

/**
 * The menu for a bar without room for its links: what the surface lists of
 * its own in `contents`, then the public site's sections, "Sell to agents"
 * first, then who is visiting, which the surface draws in `visitor` as it
 * does for the doors.
 */
export function SiteMenu({
  visitor,
  contents,
  ...drawn
}: Drawn & Readonly<{ visitor?: ReactNode; contents?: ReactNode }>) {
  return (
    <HeaderMenu>
      {contents}
      <nav aria-label="Site sections" className="site-menu-sections">
        {SECTIONS.map((section) => (
          <PlaceLink key={section.path} place={section} {...drawn}>
            {section.label}
          </PlaceLink>
        ))}
      </nav>
      {visitor}
    </HeaderMenu>
  );
}

/**
 * `to` is a section this application draws, followed without a page load and
 * fetched while the pointer rests on it; `href` is a page something else
 * serves, loaded whole.
 */
export type Section = Readonly<
  { key: string; label: ReactNode; current?: boolean } & (
    | { to: string; href?: never }
    | { href: string; to?: never }
  )
>;

/** The section on screen is named as current and is not a link to itself. */
export function SectionNav({
  label,
  sections,
  className,
}: Readonly<{ label: string; sections: readonly Section[]; className?: string }>) {
  return (
    <nav className={className} aria-label={label}>
      {sections.map((section) =>
        section.current === true ? (
          <span key={section.key} aria-current="page">
            {section.label}
          </span>
        ) : section.to === undefined ? (
          <a key={section.key} href={section.href}>
            {section.label}
          </a>
        ) : (
          <Link key={section.key} to={section.to} prefetch="intent">
            {section.label}
          </Link>
        ),
      )}
    </nav>
  );
}

/**
 * Who is signed in, for a header's doors. The whole address is in the
 * title, since the bar cuts it short where it is narrow and leaves it out on
 * a phone. The way out is a form, because signing out changes something and a
 * link can be followed by anything that reads the page; it loads the next page
 * whole, so nothing drawn for the address stays in the tab's memory.
 */
export function SignedIn({
  who,
  account,
  signOut,
}: Readonly<{
  who: string;
  /** The page about the account, where the address links to. */
  account: string;
  /** Where the sign-out form posts. */
  signOut: string;
}>) {
  return (
    <span className="site-visitor">
      <a className="site-who" href={account} title={who}>
        {who}
      </a>
      <Form className="site-sign-out" method="post" action={signOut} reloadDocument>
        <button type="submit">Sign out</button>
      </Form>
    </span>
  );
}
