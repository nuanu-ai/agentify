import type { ReactNode } from "react";

import { SiteFooter, SiteHeader } from "./site-chrome";
import { SiteLink } from "./site-link";

/**
 * Why a report's address does not open the report for this visitor.
 * "Unknown" is a dashboard that did not answer, kept apart from a stranger:
 * not knowing who somebody is must not look like knowing they are nobody.
 */
export type ReportLockedData =
  | Readonly<{ kind: "unknown"; scanId: string }>
  | Readonly<{ kind: "stranger" }>
  | Readonly<{ kind: "not_yours"; email: string }>;

/** A report's address that opens no report, in the site's message panel. */
function Locked({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <>
      <SiteHeader current="scanner" />
      <main className="message-page" id="main">
        <section className="message-panel">{children}</section>
      </main>
      <SiteFooter />
    </>
  );
}

export function ReportLocked({ page }: Readonly<{ page: ReportLockedData }>) {
  return (
    <Locked>
      {page.kind === "unknown" ? (
        <>
          <h1>We cannot tell who is visiting right now</h1>
          <p>
            The sign-in service did not answer, so we cannot check that this report is yours. Try
            again in a moment.
          </p>
          <SiteLink
            className="button button-primary"
            to={`/report/${encodeURIComponent(page.scanId)}`}
          >
            Try again
          </SiteLink>
        </>
      ) : page.kind === "not_yours" ? (
        <>
          <h1>This report belongs to another address</h1>
          <p>
            You are signed in as <strong>{page.email}</strong>. Sign in with the address the report
            was sent to.
          </p>
          {/* The dashboard's own sign-out, which ends this session and opens its sign-in. */}
          <form action="/dashboard/sign-out" className="message-actions" method="post">
            <button className="button button-primary" type="submit">
              Sign in with another address
            </button>
          </form>
        </>
      ) : (
        <>
          <h1>Sign in to open this report</h1>
          <p>
            It opens for the address it was sent to. The link in that email signs you in and opens
            it.
          </p>
          <a className="button button-primary" href="/dashboard/sign-in">
            Sign in
          </a>
        </>
      )}
    </Locked>
  );
}

/**
 * What `/report/latest` draws when the part of the site that knows who is
 * signed in did not answer; every other visitor is sent on before a page is
 * drawn.
 */
export function LatestReportUnknown() {
  return (
    <Locked>
      <h1>We cannot tell who is visiting right now</h1>
      <p>
        The sign-in service did not answer, so we cannot tell which report is yours. Try again in a
        moment.
      </p>
      <SiteLink className="button button-primary" to="/report/latest">
        Try again
      </SiteLink>
    </Locked>
  );
}
