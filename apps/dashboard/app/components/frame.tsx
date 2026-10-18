/**
 * The frame every screen about a merchant's selling is drawn in: the site
 * header with who is signed in and the way out, and under it the dashboard's
 * working area, its numbered sections in a sidebar beside a bar with the
 * screen's title, and over the screen the banner about the account where
 * something about it is not as usual. Where there is no room for
 * the sidebar, a menu at the end of the header's row holds the sections, the
 * documentation and who is signed in with the way out.
 */

import {
  Footer,
  HeaderMenu,
  OnItsWay,
  type Section,
  SectionNav,
  SignedIn,
  SiteHeader,
} from "@agentify/ui";
import type { ReactNode } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { DashboardDestination } from "../../src/dashboard-entry.js";
import type { FrameView } from "../../src/views.js";
import { useChrome } from "../answer.js";
import { AccountBanner } from "./account-banner.js";
import { useGoingTo } from "./going-to.js";
import { SurfaceNote } from "./surface-note.js";

/**
 * Each section is also a destination the sign-in returns to, so a section
 * cannot be added that the sign-in forgets.
 */
export type Tab = "cards" | Exclude<DashboardDestination, "default" | "woocommerce">;

const TABS: readonly (readonly [Tab, string])[] = [
  ["cards", "Cards"],
  ["orders", "Orders"],
  ["receipts", "Receipts"],
  ["integrations", "Integrations"],
  ["keys", "API keys"],
  ["settings", "Settings"],
];

const FOOT = [
  { href: "/docs/", label: "Documentation" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
] as const;

/** `heading` is the bar's words where they are not the window's title. */
export function Frame({
  tab,
  title,
  heading = title,
  frame,
  children,
}: Readonly<{
  /** Absent on a page that is none of the sections. */
  tab?: Tab;
  title: string;
  heading?: string;
  frame: FrameView;
  children: ReactNode;
}>) {
  const chrome = useChrome();
  const gate = useRouteLoaderData<{ who: string }>("routes/gate");
  if (gate === undefined) {
    throw new Error("the frame was drawn outside the gate, where no address is known");
  }
  const going = useGoingTo();
  const marked =
    going === null
      ? tab
      : (TABS.find(
          ([key]) => going.pathname === `/${key}` || going.pathname.startsWith(`/${key}/`),
        )?.[0] ?? tab);
  const sections: Section[] = TABS.map(([key, label], index) => ({
    key,
    label: (
      <>
        <i>{index + 1}</i>
        {label}
      </>
    ),
    current: key === marked,
    to: `/${key}`,
  }));
  const signedIn = (
    <SignedIn who={gate.who} account={`${chrome.base}/settings`} signOut="/sign-out" />
  );
  return (
    <div className="page app-frame">
      <title>{`${title} — Agentify`}</title>
      <OnItsWay />
      <SiteHeader
        surface="dashboard"
        link={Link}
        visitor={signedIn}
        menu={
          <HeaderMenu>
            <SectionNav
              className="app-menu-sections"
              label="Dashboard sections"
              sections={sections}
            />
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
            <div className="app-sidebar-name">Seller dashboard</div>
            <SectionNav className="tabs" label="Dashboard sections" sections={sections} />
            <div className="sidebar-help">
              <span>Need help?</span>
              <a href="/docs/">Open the docs →</a>
            </div>
          </div>
        </aside>
        <div className="app-workspace">
          {/* The stack's band heads the workspace rather than the window, so
              the sidebar's sections start right under the site header. */}
          <SurfaceNote surface={chrome.surface} />
          <div className="top">
            <div className="top-inner">
              <h1 className="top-title">{heading}</h1>
            </div>
          </div>
          <main className="app-content" id="main">
            <AccountBanner notes={frame.account} here={tab === undefined ? undefined : `/${tab}`} />
            {children}
          </main>
        </div>
      </div>
      <Footer links={FOOT} />
    </div>
  );
}
