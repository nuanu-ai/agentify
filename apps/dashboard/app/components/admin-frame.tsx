/**
 * A page of the operator's workspace in the workspace's frame, with the
 * channel and each section's count the workspace's layout reads.
 *
 * Drawn only under the workspace's layout (`routes/admin/only.tsx`), whose
 * loader reads the channel and the counts after the operator check.
 */

import { SignedIn, SurfaceNote } from "@agentify/ui";
import { WorkspaceFrame } from "@agentify/ui/workspace";
import type { AdminSection } from "@agentify/ui/workspace-view";
import type { ReactNode } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { AdminFrameView } from "../../src/admin/frame.js";
import { type Gated, useChrome } from "../answer.js";

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
  const gate = useRouteLoaderData<Gated>("routes/gate");
  if (gate === undefined) {
    throw new Error("the frame was drawn outside the gate, where no address is known");
  }
  const frame = useRouteLoaderData<AdminFrameView>("routes/admin/only");
  if (frame === undefined) {
    throw new Error("an admin page was drawn outside the workspace's layout");
  }
  return (
    <>
      <title>{`${title} — Agentify operator`}</title>
      <WorkspaceFrame
        surface="dashboard"
        link={Link}
        visitor={
          <SignedIn
            who={gate.who}
            account={`${chrome.base}/settings`}
            signOut={`${chrome.base}/sign-out`}
          />
        }
        channel={frame.channel}
        counts={frame.counts}
        section={section}
        heading={heading}
        find={`${chrome.base}/admin/find`}
        note={<SurfaceNote surface={chrome.surface} />}
      >
        {children}
      </WorkspaceFrame>
    </>
  );
}
