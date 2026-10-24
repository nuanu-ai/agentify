/**
 * The frame every page of the operator's workspace is drawn in: the working
 * header with the operator's mark beside the lockup, and under it the
 * workspace's sidebar headed by the channel, so an admission is never given on
 * the wrong one, with its sections in three groups, each carrying its count
 * where something waits. The bar over the page holds its title and the one box
 * that finds any record by what an operator has in hand. Where there is no
 * room for the sidebar, the menu at the end of the header's row holds the
 * channel and the sections, and the channel stands at the head of the page.
 *
 * Drawn only under the workspace's layout (`routes/admin/only.tsx`), whose
 * loader reads the channel and the counts after the operator check.
 */

import { HeaderMenu, OnItsWay, SignedIn, SiteFooter, WorkHeader } from "@agentify/ui";
import type { ReactNode } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { AdminFrameView, AdminSection, SectionCount } from "../../src/admin/frame.js";
import { useChrome } from "../answer.js";
import { SurfaceNote } from "./surface-note.js";

interface SectionLink {
  readonly section: AdminSection;
  readonly label: string;
  /** Under the dashboard's prefix; the scanner's page is the site's own `/admin`. */
  readonly to: string;
  readonly elsewhere?: true;
}

const GROUPS: readonly (readonly [string, readonly SectionLink[]])[] = [
  [
    "Business",
    [
      { section: "overview", label: "Overview", to: "/admin" },
      { section: "merchants", label: "Merchants", to: "/admin/merchants" },
      { section: "orders", label: "Orders", to: "/admin/orders" },
      { section: "money", label: "Money", to: "/admin/money" },
    ],
  ],
  [
    "Machine",
    [
      { section: "health", label: "Health", to: "/admin/health" },
      { section: "scanner", label: "Scanner", to: "/admin", elsewhere: true },
    ],
  ],
  [
    "People",
    [
      { section: "accounts", label: "Accounts", to: "/admin/accounts" },
      { section: "journal", label: "Journal", to: "/admin/journal" },
    ],
  ],
];

/** The frame's view, which the workspace's layout loads for every page under it. */
const useAdminFrame = (): AdminFrameView => {
  const frame = useRouteLoaderData<AdminFrameView>("routes/admin/only");
  if (frame === undefined) {
    throw new Error("an admin page was drawn outside the workspace's layout");
  }
  return frame;
};

const Count = ({ counted }: Readonly<{ counted: SectionCount | undefined }>) =>
  counted === undefined || counted.count === 0 ? null : (
    <span className={counted.needsYou ? "count warn" : "count"}>{counted.count}</span>
  );

function Sections({
  current,
  counts,
}: Readonly<{ current: AdminSection | undefined; counts: AdminFrameView["counts"] }>) {
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
              ) : link.elsewhere === true ? (
                <a key={link.section} href={link.to}>
                  {words}
                </a>
              ) : (
                <Link key={link.section} to={link.to}>
                  {words}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

/** The lookup: a form that reads, so its answer has an address of its own. */
function Lookup() {
  const { base } = useChrome();
  return (
    <search>
      <form className="op-lookup" method="get" action={`${base}/admin/find`}>
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

export function AdminFrame({
  section,
  title,
  heading = title,
  children,
}: Readonly<{
  /** Absent on a page that is none of the sections, such as the lookup's. */
  section?: AdminSection;
  title: string;
  heading?: string;
  children: ReactNode;
}>) {
  const chrome = useChrome();
  const gate = useRouteLoaderData<{ who: string }>("routes/gate");
  if (gate === undefined) {
    throw new Error("the frame was drawn outside the gate, where no address is known");
  }
  const frame = useAdminFrame();
  const { channel } = frame;
  const live = channel.mode === "live";
  const signedIn = (
    <SignedIn who={gate.who} account={`${chrome.base}/settings`} signOut="/sign-out" />
  );
  return (
    <div className="page app-frame">
      <title>{`${title} — Agentify operator`}</title>
      <OnItsWay />
      <WorkHeader
        surface="dashboard"
        link={Link}
        mark={<span className="op-mark">Operator</span>}
        visitor={signedIn}
        menu={
          <HeaderMenu>
            <p className="op-menu-channel">
              {channel.name} · {channel.line}
            </p>
            <Sections current={section} counts={frame.counts} />
            <a className="app-menu-docs" href="/docs/">
              Open the docs →
            </a>
            {signedIn}
          </HeaderMenu>
        }
      />
      <div className="app-shell">
        <aside className="app-sidebar">
          <div className="app-sidebar-inner">
            <div className={live ? "op-channel" : "op-channel test"}>
              <span className="badge">{channel.name}</span>
              <span className="op-channel-sub">{channel.line}</span>
            </div>
            <Sections current={section} counts={frame.counts} />
          </div>
        </aside>
        <div className="app-workspace">
          <SurfaceNote surface={chrome.surface} />
          <main id="main">
            <div className="top">
              <div className="top-inner">
                <h1 className="top-title">{heading}</h1>
                <Lookup />
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
      <SiteFooter surface="dashboard" link={Link} />
    </div>
  );
}
