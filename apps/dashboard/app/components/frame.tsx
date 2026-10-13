/**
 * The frame every screen about a merchant's selling is drawn in: the site
 * header with who is signed in and the way out, and under it the dashboard's
 * working area, its numbered sections in a sidebar beside a bar with the
 * screen's title and the merchant's selling state. Where there is no room for
 * the sidebar, a menu at the end of the header's row holds the sections, the
 * documentation and who is signed in with the way out.
 */

import { Footer, OnItsWay, type Section, SectionNav, SignedIn, SiteHeader } from "@agentify/ui";
import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { DashboardDestination } from "../../src/dashboard-entry.js";
import type { FrameView } from "../../src/views.js";
import { useChrome } from "../answer.js";
import { useGoingTo } from "./going-to.js";
import { SurfaceNote } from "./surface-note.js";
import { Word } from "./word.js";

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

/**
 * Says the consequence (a card the merchant's code publishes is refused) and
 * points at the page that fixes it, because the API's refusal names a route,
 * which is the wrong sentence for somebody looking at a page.
 */
function Unnamed({ base }: Readonly<{ base: string }>) {
  return (
    <div className="callout">
      <div className="what">
        You cannot publish products until you choose the seller name buyers will see.
      </div>
      <p className="why">
        A card without a seller name is refused.{" "}
        <a href={`${base}/settings`}>Choose a seller name in Settings</a>.
      </p>
    </div>
  );
}

/**
 * A details element, so it opens and closes with no script; Escape closes it
 * too and hands the focus back to the button that opened it, which a details
 * element does not do on its own.
 */
function Menu({
  sections,
  account,
}: Readonly<{ sections: readonly Section[]; account: ReactNode }>) {
  const menu = useRef<HTMLDetailsElement>(null);
  const closeOnEscape = (event: KeyboardEvent<HTMLDetailsElement>) => {
    const details = menu.current;
    if (event.key !== "Escape" || details === null || !details.open) return;
    details.open = false;
    details.querySelector("summary")?.focus();
  };
  return (
    <details className="app-menu" ref={menu} onKeyDown={closeOnEscape}>
      <summary aria-label="Menu">
        <span />
        <span />
        <span />
      </summary>
      <div className="app-menu-panel">
        <SectionNav className="app-menu-sections" label="Dashboard sections" sections={sections} />
        <a className="app-menu-docs" href="/docs/">
          Open the docs →
        </a>
        <div className="app-menu-account">{account}</div>
      </div>
    </details>
  );
}

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
        menu={<Menu sections={sections} account={signedIn} />}
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
              {frame.selling === undefined ? null : <Word word={frame.selling} />}
            </div>
          </div>
          <main className="app-content" id="main">
            {frame.unnamed ? <Unnamed base={chrome.base} /> : null}
            {children}
          </main>
        </div>
      </div>
      <Footer links={FOOT} />
    </div>
  );
}
