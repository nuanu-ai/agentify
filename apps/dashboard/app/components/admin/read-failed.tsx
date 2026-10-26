/**
 * The error page of a workspace page whose read failed: said inside the
 * workspace's frame, under the page's own heading, with the same address
 * offered again, so the operator keeps their place. A read changes nothing.
 *
 * It draws the frame only where the workspace's layout answered, which it
 * does for an operator alone; anything else, and a press that failed, is the
 * dashboard's own error page, so this never tells anybody else the workspace
 * is there.
 */

import type { AdminSection } from "@agentify/ui/workspace-view";
import { isRouteErrorResponse, Link, useRouteError, useRouteLoaderData } from "react-router";
import type { AdminFrameView } from "../../../src/admin/frame.js";
import type { Gated, Trouble } from "../../answer.js";
import { ErrorBoundary as PageTrouble } from "../../root.js";
import { AdminFrame } from "../admin-frame.js";

export const readFailedIn = ({
  section,
  title,
  back,
}: Readonly<{
  section?: AdminSection;
  title: string;
  /** Where a record that is not there leads, such as the list it would be in. */
  back?: Readonly<{ to: string; words: string }>;
}>) =>
  function ReadFailed() {
    const error = useRouteError();
    const trouble = isRouteErrorResponse(error) ? (error.data as Trouble | undefined) : undefined;
    const gate = useRouteLoaderData<Gated>("routes/gate");
    const frame = useRouteLoaderData<AdminFrameView>("routes/admin/only");
    if (gate === undefined || frame === undefined || trouble === undefined) return <PageTrouble />;
    if (trouble.kind === "unread") {
      return (
        <AdminFrame section={section} title={title}>
          <div className="message-panel" role="alert">
            <p>This page could not be read.</p>
            <a className="button button-primary" href={trouble.again}>
              Read again
            </a>
          </div>
        </AdminFrame>
      );
    }
    // A record that is not there, said in the frame; a refusal of a press
    // carries no address to read again and is the dashboard's own page.
    if (trouble.kind === "problem" && trouble.again !== undefined) {
      return (
        <AdminFrame section={section} title={title}>
          <div className="message-panel" role="alert">
            <p>{trouble.said}</p>
            {back === undefined ? null : (
              <Link className="button button-secondary" to={back.to}>
                {back.words}
              </Link>
            )}
          </div>
        </AdminFrame>
      );
    }
    return <PageTrouble />;
  };
