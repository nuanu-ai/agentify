/**
 * The frame every page of the operator's workspace is drawn in, by whichever
 * application serves the page: the working header with the operator's mark
 * beside the lockup, and under it the workspace's sidebar headed by the
 * channel, so an admission is never given on the wrong one, with its sections
 * in three groups, each carrying its count where something waits. The bar
 * over the page holds its title and the one box that finds any record by what
 * an operator has in hand. Where there is no room for the sidebar, the menu at
 * the end of the header's row holds the channel and the sections, and the
 * channel stands at the head of the page.
 *
 * The seller dashboard serves every section but one, the scanner's, which the
 * scanner serves at its own `/admin`; a section the drawing application does
 * not serve is a plain link loaded whole. Drawn with no script, so the menu
 * opens as a details element does.
 */

import type { ReactNode } from "react";
import { SiteFooter } from "./footer.js";
import { type Drawn, type Place, PlaceLink, WorkHeader } from "./header.js";
import { HeaderMenu } from "./menu.js";
import type { AdminSection, ChannelView, SectionCount, SectionCounts } from "./workspace-view.js";

interface SectionLink {
  readonly section: AdminSection;
  readonly label: string;
  readonly place: Place;
}

const at = (path: string): Place => ({ owner: "dashboard", path });

const GROUPS: readonly (readonly [string, readonly SectionLink[]])[] = [
  [
    "Business",
    [
      { section: "overview", label: "Overview", place: at("/admin") },
      { section: "merchants", label: "Merchants", place: at("/admin/merchants") },
      { section: "orders", label: "Orders", place: at("/admin/orders") },
      { section: "money", label: "Money", place: at("/admin/money") },
    ],
  ],
  [
    "Machine",
    [
      { section: "health", label: "Health", place: at("/admin/health") },
      { section: "scanner", label: "Scanner", place: { owner: "scanner", path: "/admin" } },
    ],
  ],
  [
    "People",
    [
      { section: "accounts", label: "Accounts", place: at("/admin/accounts") },
      { section: "journal", label: "Journal", place: at("/admin/journal") },
    ],
  ],
];

const Count = ({ counted }: Readonly<{ counted: SectionCount | undefined }>) =>
  counted === undefined || counted.count === 0 ? null : (
    <span className={counted.needsYou ? "count warn" : "count"}>{counted.count}</span>
  );

function Sections({
  current,
  counts,
  ...drawn
}: Drawn & Readonly<{ current: AdminSection | undefined; counts: SectionCounts }>) {
  return (
    <nav aria-label="Admin sections">
      {GROUPS.map(([group, links]) => (
        <div key={group}>
          <p className="op-group">{group}</p>
          <div className="tabs op-tabs">
            {links.map((link) => {
              const words = (
                <>
                  {link.label}
                  <Count counted={counts[link.section]} />
                </>
              );
              return link.section === current ? (
                <span key={link.section} aria-current="page">
                  {words}
                </span>
              ) : (
                <PlaceLink key={link.section} place={link.place} {...drawn}>
                  {words}
                </PlaceLink>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

/** The lookup: a form that reads, so its answer has an address of its own. */
function Lookup({ find }: Readonly<{ find: string }>) {
  return (
    <search>
      <form className="op-lookup" method="get" action={find}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          className="field-input"
          type="search"
          name="q"
          aria-label="Find a record"
          placeholder="Find a record"
        />
      </form>
    </search>
  );
}

/**
 * `visitor` is who is signed in with the way out, as the header's doors draw
 * it. `counts` are the sections' counts where the drawing application can read
 * them; without them no section carries one, since a count left out claims
 * nothing while a zero would claim that nothing waits. `find` is the address
 * the lookup reads. `note` stands at the head of the workspace, over the bar.
 */
export function WorkspaceFrame({
  visitor,
  channel,
  counts = {},
  section,
  heading,
  find,
  note,
  children,
  ...drawn
}: Drawn &
  Readonly<{
    visitor: ReactNode;
    channel: ChannelView;
    counts?: SectionCounts;
    /** Absent on a page that is none of the sections, such as the lookup's. */
    section?: AdminSection;
    heading: string;
    find: string;
    note?: ReactNode;
    children: ReactNode;
  }>) {
  return (
    <div className="page app-frame">
      <WorkHeader
        {...drawn}
        mark={<span className="op-mark">Operator</span>}
        visitor={visitor}
        menu={
          <HeaderMenu>
            <p className="op-menu-channel">
              {channel.name} · {channel.line}
            </p>
            <Sections current={section} counts={counts} {...drawn} />
            <a className="app-menu-door" href="/docs/">
              Open the docs →
            </a>
            {visitor}
          </HeaderMenu>
        }
      />
      <div className="app-shell">
        <aside className="app-sidebar">
          <div className="app-sidebar-inner">
            <div className={channel.mode === "live" ? "op-channel" : "op-channel test"}>
              <span className="badge">{channel.name}</span>
              <span className="op-channel-sub">{channel.line}</span>
            </div>
            <Sections current={section} counts={counts} {...drawn} />
          </div>
        </aside>
        <div className="app-workspace">
          {note}
          <main id="main">
            <div className="top">
              <div className="top-inner">
                <h1 className="top-title">{heading}</h1>
                <Lookup find={find} />
              </div>
            </div>
            <div className="app-content">
              <p className="op-channel-line">
                <span className="badge">{channel.name}</span>
                <span>{channel.line}</span>
              </p>
              {children}
            </div>
          </main>
        </div>
      </div>
      <SiteFooter {...drawn} />
    </div>
  );
}
