/**
 * The frame every page of the operator's workspace is drawn in, by whichever
 * application serves the page: the working header with the operator's mark
 * beside the lockup, and under it the workspace's sidebar with its sections
 * in three groups, each carrying its count where something waits. The channel
 * is named once, so an admission is never given on the wrong one: by the
 * stack's band on a test stack, and on the live one, which draws no band, at
 * the head of the sidebar, or of the page and the menu where there is no
 * room for the sidebar. The bar over the page holds its title and the one box
 * that finds any record by what an operator has in hand.
 *
 * The seller dashboard serves every section but one, the scanner's, which the
 * scanner serves at its own `/admin`; a section the drawing application does
 * not serve is a plain link loaded whole. Drawn with no script, so the menu
 * opens as a details element does.
 */

import type { ReactNode } from "react";
import { SiteFooter } from "./footer.js";
import { type Drawn, type Place, PlaceLink, WorkHeader } from "./header.js";
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
          placeholder="ID, email, site or transaction"
        />
      </form>
    </search>
  );
}

/**
 * `who` is the operator signed in, whose way back to their seller dashboard
 * the header holds beside the workspace's. `counts` are the sections' counts
 * where the drawing application can read them; without them no section
 * carries one, since a count left out claims nothing while a zero would claim
 * that nothing waits. `find` is the address the lookup reads, absent on the
 * lookup's own page, which has its box. `note` stands at the head of the
 * workspace, over the bar.
 */
export function WorkspaceFrame({
  who,
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
    who: string;
    channel: ChannelView;
    counts?: SectionCounts;
    /** Absent on a page that is none of the sections, such as the lookup's. */
    section?: AdminSection;
    heading: string;
    find?: string;
    note?: ReactNode;
    children: ReactNode;
  }>) {
  const live = channel.mode === "live";
  return (
    <div className="page app-frame">
      <WorkHeader
        {...drawn}
        current="admin"
        mark={<span className="op-mark">Operator</span>}
        visitor={{ status: "signed_in", email: who, operator: true }}
        contents={
          <>
            {live && <p className="op-menu-channel">{channel.name}</p>}
            <Sections current={section} counts={counts} {...drawn} />
          </>
        }
      />
      <div className="app-shell">
        <aside className="app-sidebar">
          <div className="app-sidebar-inner">
            {live && (
              <div className="op-channel">
                <span className="badge">{channel.name}</span>
              </div>
            )}
            <Sections current={section} counts={counts} {...drawn} />
          </div>
        </aside>
        <div className="app-workspace">
          {note}
          <main id="main">
            <div className="top">
              <div className="top-inner">
                <h1 className="top-title">{heading}</h1>
                {find !== undefined && <Lookup find={find} />}
              </div>
            </div>
            <div className="app-content">
              {live && (
                <p className="op-channel-line">
                  <span className="badge">{channel.name}</span>
                </p>
              )}
              {children}
            </div>
          </main>
        </div>
      </div>
      <SiteFooter {...drawn} />
    </div>
  );
}
