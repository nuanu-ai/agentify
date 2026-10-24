/**
 * The frame every screen about a merchant's selling is drawn in: the working
 * header with the documentation and who is signed in with the way out, and
 * under it the dashboard's working area, its sections in a sidebar beside a
 * bar with the screen's title, and over the screen the banner about the
 * account where something about it is not as usual. Where there is no room
 * for the sidebar, a menu at the end of the header's row holds the sections,
 * the documentation and who is signed in with the way out.
 */

import {
  HeaderMenu,
  OnItsWay,
  type Section,
  SectionNav,
  SignedIn,
  SiteFooter,
  WorkHeader,
} from "@agentify/ui";
import type { ReactNode } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { SectionDestination } from "../../src/dashboard-entry.js";
import type { FrameView } from "../../src/views.js";
import type { Chrome, DrawnFor } from "../answer.js";
import { AccountBanner } from "./account-banner.js";
import { useGoingTo } from "./going-to.js";
import { SurfaceNote } from "./surface-note.js";

/**
 * Each section is also a destination the sign-in returns to, so a section
 * cannot be added that the sign-in forgets.
 */
export type Tab = "cards" | Exclude<SectionDestination, "default" | "woocommerce">;

const TABS: readonly (readonly [Tab, string])[] = [
  ["cards", "Cards"],
  ["orders", "Orders"],
  ["receipts", "Receipts"],
  ["integrations", "Integrations"],
  ["keys", "API keys"],
  ["settings", "Settings"],
];

/**
 * `heading` is the bar's words where they are not the window's title, and
 * `action` a control about the whole page, drawn at the bar's end at every
 * width, so a phone reaches it without scrolling past the page. The banner is
 * the merchant's pages' layout's, read once for every section; a page drawn
 * outside that layout draws none. A page drawn where no loader ran is handed
 * what the root, the gate and that layout would have read, as `drawn`.
 */
export function Frame({
  tab,
  title,
  heading = title,
  action,
  navigation,
  drawn,
  children,
}: Readonly<{
  /** Absent on a page that is none of the sections. */
  tab?: Tab;
  title: string;
  heading?: string;
  action?: ReactNode;
  /** The administrative workspace uses the same frame with its own sections. */
  navigation?: Readonly<{ label: string; sections: readonly Section[] }>;
  drawn?: DrawnFor & Readonly<{ chrome: Chrome }>;
  children: ReactNode;
}>) {
  const chrome = useRouteLoaderData<Chrome>("root") ?? drawn?.chrome;
  if (chrome === undefined) {
    throw new Error("a page was drawn without the root's chrome, which every page loads first");
  }
  const gate =
    useRouteLoaderData<{ who: string }>("routes/gate") ??
    (drawn === undefined ? undefined : { who: drawn.who });
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
  const framed = useRouteLoaderData<FrameView>("routes/merchant-only") ?? drawn?.framed;
  const sections: readonly Section[] =
    navigation?.sections ??
    TABS.map(([key, label]) => ({
      key,
      label,
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
      <WorkHeader
        surface="dashboard"
        link={Link}
        visitor={signedIn}
        menu={
          <HeaderMenu>
            <SectionNav
              className="app-menu-sections"
              label={navigation?.label ?? "Dashboard sections"}
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
            <SectionNav
              className="tabs"
              label={navigation?.label ?? "Dashboard sections"}
              sections={sections}
            />
          </div>
        </aside>
        <div className="app-workspace">
          {/* The stack's band heads the workspace rather than the window, so
              the sidebar's sections start right under the header. */}
          <SurfaceNote surface={chrome.surface} />
          {/* The bar is inside the page's main part, so the way past the
              header leads to its title and the control at its end. */}
          <main id="main">
            <div className="top">
              <div className="top-inner">
                <h1 className="top-title">{heading}</h1>
                {action}
              </div>
            </div>
            <div className="app-content">
              <AccountBanner notes={framed?.account ?? []} />
              {children}
            </div>
          </main>
        </div>
      </div>
      <SiteFooter surface="dashboard" link={Link} />
    </div>
  );
}
