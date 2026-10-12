/**
 * The frame every screen about a merchant's selling is drawn in: the numbered
 * sections in a sidebar, and over the page a bar with the screen's title, the
 * merchant's selling state and who is signed in with the way out.
 */

import { BrandLockup, Footer, type Section, SectionNav, SignedIn } from "@agentify/ui";
import type { ReactNode } from "react";
import { useRouteLoaderData } from "react-router";
import type { DashboardDestination } from "../../src/dashboard-entry.js";
import type { FrameView } from "../../src/views.js";
import { useChrome } from "../answer.js";
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
      <div className="why">
        A card without a seller name is refused.{" "}
        <a href={`${base}/settings`}>Choose a seller name in Settings</a>.
      </div>
    </div>
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
  const sections: Section[] = TABS.map(([key, label], index) => ({
    key,
    label: (
      <>
        <i>{index + 1}</i>
        {label}
      </>
    ),
    current: key === tab,
    to: `/${key}`,
  }));
  return (
    <div className="page">
      <title>{`${title} — Agentify`}</title>
      <div className="app-shell">
        <aside className="app-sidebar">
          <div className="app-sidebar-brand">
            <BrandLockup home="/" />
            <span>SELLER DASHBOARD</span>
          </div>
          <SectionNav className="tabs" label="Dashboard sections" sections={sections} />
          <div className="sidebar-help">
            <span>Need help?</span>
            <a href="/docs/">Open the docs →</a>
          </div>
          {/* A details element, so it opens and closes with no script. Who is
              signed in and the way out stay in the bar at every width, so the
              menu does not repeat them. */}
          <details className="app-menu">
            <summary aria-label="Menu">
              <span />
              <span />
              <span />
            </summary>
            <div className="app-menu-panel">
              <SectionNav
                className="app-menu-sections"
                label="Dashboard sections"
                sections={sections}
              />
              <a className="app-menu-docs" href="/docs/">
                Open the docs →
              </a>
            </div>
          </details>
        </aside>
        <div className="app-workspace">
          {/* The stack's band heads the workspace rather than the window: a
              band above the full-height sticky sidebar would push its foot
              below the first screen. */}
          <SurfaceNote surface={chrome.surface} />
          <header className="top">
            <div className="top-inner">
              <h1 className="top-title">{heading}</h1>
              {frame.selling === undefined ? null : <Word word={frame.selling} />}
              <SignedIn
                className="account"
                who={gate.who}
                account={`${chrome.base}/settings`}
                signOut="/sign-out"
              />
            </div>
          </header>
          <main className="app-content">
            {frame.unnamed ? <Unnamed base={chrome.base} /> : null}
            {children}
          </main>
        </div>
      </div>
      <Footer links={FOOT} />
    </div>
  );
}
