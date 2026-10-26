/**
 * The bar at the top of every page of the site, and the sections a working
 * page lists in its sidebar and its menu.
 *
 * The bar is the same on every page: the lockup, then on the public pages
 * what the site offers, the scanner and selling to agents; at its end the
 * places a person comes back to, the documentation, the dashboard and, for an
 * operator, the operator's workspace, and last who is signed in, a button with
 * the address that opens the account's settings and the way out. Where the
 * window is narrow the row keeps the lockup, the documentation, the dashboard
 * and a menu's button, and the menu holds the rest.
 *
 * The site is served by more than one process on one origin. A link to a page
 * the surface drawing it serves is that surface's own router link, followed
 * without a page load; a link to a page another process serves is a plain
 * anchor, because the router would look for it among its own pages and draw
 * the page that says there is none.
 */

import type { ComponentType, ReactNode } from "react";
import { Link, useHref } from "react-router";
import { BrandMark } from "./mark.js";
import { AccountMenu, HeaderMenu } from "./menu.js";
import type { Visitor } from "./visitor.js";

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

/** The part of the site a page belongs to, marked in the bar; a page of none marks nothing. */
export type Current = "scanner" | "sell" | "docs" | "dashboard" | "admin";

type Named = Place & Readonly<{ part: Current; label: string }>;

/** What the site offers, at the start of the public pages' bar. */
const OFFERS: readonly Named[] = [
  { part: "scanner", owner: "scanner", path: "/", label: "Scanner" },
  { part: "sell", owner: "scanner", path: "/agentic-shop", label: "Sell to agents" },
];

/**
 * The places at the end of every bar. The dashboard's door leads from
 * elsewhere to its sign-in, which sends somebody already signed in on to
 * their dashboard, and inside the dashboard to its own start, so the door is
 * the same word and the same address for everybody on a page a shared cache
 * keeps.
 */
const doorsFor = (surface: Surface, operator: boolean): readonly Named[] => [
  { part: "docs", owner: "docs", path: "/", label: "Docs" },
  {
    part: "dashboard",
    owner: "dashboard",
    path: surface === "dashboard" ? "/" : "/sign-in",
    label: "Dashboard",
  },
  ...(operator
    ? [{ part: "admin", owner: "dashboard", path: "/admin", label: "Admin" } as const]
    : []),
];

const SETTINGS: Place = { owner: "dashboard", path: "/settings" };

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
  const marked = current ? "true" : undefined;
  if (place.owner === surface) {
    return (
      <Own className={className} to={place.path} aria-current={marked}>
        {children}
      </Own>
    );
  }
  return (
    <a className={className} href={`${MOUNTED_AT[place.owner]}${place.path}`} aria-current={marked}>
      {children}
    </a>
  );
}

const Links = ({
  places,
  current,
  className,
  ...drawn
}: Drawn &
  Readonly<{ places: readonly Named[]; current: Current | undefined; className?: string }>) =>
  places.map((place) => (
    <PlaceLink
      key={place.part}
      className={className}
      place={place}
      current={place.part === current}
      {...drawn}
    >
      {place.label}
    </PlaceLink>
  ));

/**
 * The way out is a form, because signing out changes something and a link
 * can be followed by anything that reads the page; the browser posts it
 * itself and loads the next page whole, so nothing drawn for the address stays
 * in the tab's memory.
 */
function SignOut({ surface }: Readonly<{ surface: Surface }>) {
  const own = useHref("/sign-out");
  return (
    <form
      className="site-sign-out"
      method="post"
      action={surface === "dashboard" ? own : `${MOUNTED_AT.dashboard}/sign-out`}
    >
      <button type="submit">Sign out</button>
    </form>
  );
}

/** Said where the part of the site that knows who is signed in did not answer, apart from nobody being signed in. */
const UNKNOWN = "Sign-in unknown";

/**
 * Who is signed in, at the end of the row: nothing while the surface is still
 * finding out and for a stranger, so a stranger's bar never changes, and the
 * account's menu once an address is known. Busy while finding out, which is
 * what a screen reader announces.
 */
function AccountSlot({ visitor, ...drawn }: Drawn & Readonly<{ visitor: Visitor }>) {
  return (
    <span className="site-visitor" aria-busy={visitor.status === "loading"}>
      {visitor.status === "unknown" ? (
        <span className="site-unknown">{UNKNOWN}</span>
      ) : visitor.status === "signed_in" ? (
        <AccountMenu who={visitor.email}>
          <PlaceLink place={SETTINGS} {...drawn}>
            Settings
          </PlaceLink>
          <SignOut surface={drawn.surface} />
        </AccountMenu>
      ) : null}
    </span>
  );
}

/** Who is signed in, under a rule at the foot of the narrow window's menu, the address whole. */
function MenuAccount({
  visitor,
  settings,
  ...drawn
}: Drawn & Readonly<{ visitor: Visitor; settings: boolean }>) {
  if (visitor.status === "unknown") {
    return (
      <div className="site-menu-account">
        <p className="site-unknown">{UNKNOWN}</p>
      </div>
    );
  }
  if (visitor.status !== "signed_in") return null;
  return (
    <div className="site-menu-account">
      <p className="site-who">{visitor.email}</p>
      {settings ? (
        <PlaceLink place={SETTINGS} {...drawn}>
          Settings
        </PlaceLink>
      ) : null}
      <SignOut surface={drawn.surface} />
    </div>
  );
}

/**
 * The one bar. `offers` puts what the site offers after the lockup; `mark`
 * stands beside the lockup at every width, where a workspace says whose it
 * is, and takes the room the doors keep on a narrow window, so the menu holds
 * them there. `contents` heads the menu with what the page lists of its own.
 */
function Bar({
  offers,
  current,
  visitor,
  mark,
  contents,
  settingsInContents,
  ...drawn
}: Drawn &
  Readonly<{
    offers: boolean;
    current: Current | undefined;
    visitor: Visitor;
    mark?: ReactNode;
    contents?: ReactNode;
    settingsInContents: boolean;
  }>) {
  const doors = doorsFor(drawn.surface, visitor.status === "signed_in" && visitor.operator);
  // The doors the narrow window's row leaves out, which its menu lists.
  const folded = mark === undefined ? doors.filter((door) => door.part === "admin") : doors;
  const lockup = (
    <PlaceLink className="brand" place={HOME} {...drawn}>
      <BrandMark className="brand-mark" />
      <span>Agentify</span>
    </PlaceLink>
  );
  return (
    <header className={mark === undefined ? "site-header" : "site-header site-header-marked"}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="site-header-inner container">
        {mark === undefined ? (
          lockup
        ) : (
          <span className="brand-marked">
            {lockup}
            {mark}
          </span>
        )}
        {offers ? (
          <nav aria-label="Primary" className="site-nav">
            <Links places={OFFERS} current={current} {...drawn} />
          </nav>
        ) : null}
        <div className="site-header-end">
          <nav aria-label="Docs and dashboard" className="site-doors">
            <Links
              places={doors.filter((door) => !folded.includes(door))}
              current={current}
              {...drawn}
            />
            <Links places={folded} current={current} className="site-folds" {...drawn} />
          </nav>
          <AccountSlot visitor={visitor} {...drawn} />
          <HeaderMenu>
            {contents === undefined ? null : <div className="site-menu-contents">{contents}</div>}
            {offers || folded.length > 0 ? (
              <nav aria-label="Site sections" className="site-menu-sections">
                {offers ? <Links places={OFFERS} current={current} {...drawn} /> : null}
                <Links places={folded} current={current} {...drawn} />
              </nav>
            ) : null}
            <MenuAccount visitor={visitor} settings={!settingsInContents} {...drawn} />
          </HeaderMenu>
        </div>
      </div>
    </header>
  );
}

/**
 * The bar over a page of the public site, the documentation's included: what
 * the site offers after the lockup. `current` is the part of the site the
 * page belongs to; `visitor` is who is signed in as far as the surface knows;
 * `contents` heads the narrow window's menu where the page has a list of its
 * own that the narrow window has no room for.
 */
export function SiteHeader({
  current,
  visitor,
  contents,
  ...drawn
}: Drawn & Readonly<{ current?: Current; visitor: Visitor; contents?: ReactNode }>) {
  return (
    <Bar
      offers
      current={current}
      visitor={visitor}
      contents={contents}
      settingsInContents={false}
      {...drawn}
    />
  );
}

/**
 * The bar over a page a signed-in person works in, whose sections stand in a
 * sidebar: the lockup alone at its start, lined up with the sidebar, and the
 * same end as every bar. `contents` are those sections, which the narrow
 * window's menu lists where there is no room for the sidebar; the seller
 * dashboard's end with its settings, so the menu does not name them twice.
 */
export function WorkHeader({
  current,
  visitor,
  contents,
  mark,
  ...drawn
}: Drawn &
  Readonly<{
    current: "dashboard" | "admin";
    visitor: Extract<Visitor, { status: "signed_in" }>;
    contents: ReactNode;
    mark?: ReactNode;
  }>) {
  return (
    <Bar
      offers={false}
      current={current}
      visitor={visitor}
      mark={mark}
      contents={contents}
      settingsInContents={current === "dashboard"}
      {...drawn}
    />
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
