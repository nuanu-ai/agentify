import { BrandLockup } from "@agentify/ui";
import type { ReactNode } from "react";
import type { Chrome } from "../answer.js";
import { SurfaceNote } from "./surface-note.js";

/**
 * A page outside the dashboard's frame: the ones in front of the gate, and
 * those that say a page could not be drawn. One card under the lockup.
 */
export function GatePage({
  chrome,
  title,
  children,
}: Readonly<{ chrome: Chrome; title: string; children: ReactNode }>) {
  return (
    <>
      <title>{`${title} — Agentify`}</title>
      <SurfaceNote surface={chrome.surface} />
      <div className="gate">
        <BrandLockup home="/" />
        {children}
      </div>
    </>
  );
}
