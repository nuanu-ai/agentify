/**
 * The site header every surface draws at the top of its pages, and the parts
 * a surface places inside its own layout: the lockup, a surface's sections
 * and who is signed in with the way out.
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

/** The surfaces that draw the site header, each a process of its own. */
export type Surface = "scanner" | "dashboard";

/**
 * How a surface links to a page of its own: `to` is the page's path inside
 * the surface, as its router names it.
 */
type OwnLink = ComponentType<
  Readonly<{ to: string; className?: string; "aria-current"?: "true"; children: ReactNode }>
>;

type Owner = Surface | "docs";

/** Where on the origin each process answers. */
const MOUNTED_AT: Readonly<Record<Owner, string>> = {
  scanner: "",
  dashboard: "/dashboard",
  docs: "/docs",
};

type Place = Readonly<{ owner: Owner; path: string }>;

const HOME: Place = { owner: "scanner", path: "/" };

const SECTIONS: readonly (Place & Readonly<{ label: string }>)[] = [
  { owner: "scanner", path: "/agentic-shop", label: "Sell to agents" },
  { owner: "scanner", path: "/scanner", label: "Scanner" },
  { owner: "scanner", path: "/methodology", label: "Methodology" },
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
};

/** What every part of the header needs to draw a link: who draws it, and how it links home. */
type Drawn = Readonly<{ surface: Surface; link: OwnLink }>;

/** `current` marks the link to the part of the site the page belongs to. */
function PlaceLink({
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
      <PlaceLink place={DOCS} {...drawn}>
        Docs
      </PlaceLink>
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
 * The bar over every page of the site: the lockup, the public site's sections
 * and the doors, then `menu`, a surface's own menu, at the end of the row; a
 * menu that opens a panel places it under the bar, which stays in view.
 */
export function SiteHeader({
  visitor,
  menu,
  ...drawn
}: Drawn & Readonly<{ visitor?: ReactNode; menu?: ReactNode }>) {
  return (
    <header className="site-header">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="site-header-inner container">
        <PlaceLink className="brand" place={HOME} {...drawn}>
          <BrandMark className="brand-mark" />
          <span>Agentify</span>
        </PlaceLink>
        <div className="site-header-links">
          <nav aria-label="Primary" className="site-nav">
            {SECTIONS.map((section) => (
              <PlaceLink key={section.path} place={section} {...drawn}>
                {section.label}
              </PlaceLink>
            ))}
          </nav>
          <SiteDoors visitor={visitor} {...drawn} />
          {menu}
        </div>
      </div>
    </header>
  );
}

/**
 * The menu for a bar without room for its links: the public site's sections,
 * "Sell to agents" first, then who is visiting, which the surface draws in
 * `visitor` as it does for the doors.
 */
export function SiteMenu({ visitor, ...drawn }: Drawn & Readonly<{ visitor?: ReactNode }>) {
  return (
    <HeaderMenu>
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
 * Who is signed in, for the site header's doors. The whole address is in the
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
