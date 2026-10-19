import { SignedIn, SiteFooter, SiteHeader } from "@agentify/ui";
import type { ReactNode } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { Chrome } from "../answer.js";
import { SurfaceNote } from "./surface-note.js";

/**
 * A page outside the dashboard's frame: the ones in front of the gate, and
 * those that say a page could not be drawn. One card between the site header,
 * which names who is signed in wherever the gate has said so, and the site
 * footer.
 */
export function GatePage({
  chrome,
  title,
  children,
}: Readonly<{ chrome: Chrome; title: string; children: ReactNode }>) {
  const gate = useRouteLoaderData<{ who: string }>("routes/gate");
  return (
    <div className="page">
      <title>{`${title} — Agentify`}</title>
      <SiteHeader
        surface="dashboard"
        link={Link}
        visitor={
          gate === undefined ? null : (
            <SignedIn who={gate.who} account={`${chrome.base}/settings`} signOut="/sign-out" />
          )
        }
      />
      <SurfaceNote surface={chrome.surface} />
      <main className="gate" id="main">
        {children}
      </main>
      <SiteFooter surface="dashboard" link={Link} />
    </div>
  );
}
