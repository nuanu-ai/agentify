import type { ReactNode } from "react";

import layout from "./result-layout.module.css";
import { SiteFooter, SiteTop } from "./site-chrome";
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

/** A report's address that opens no report, in the report's own page. */
function Locked({ children, doors = true }: Readonly<{ children: ReactNode; doors?: boolean }>) {
  return (
    <div className={layout.page}>
      <SiteTop end={doors ? undefined : null} />
      <main className={layout.body}>
        <div className={`${layout.sheet} ${layout.single}`}>
          <section className={layout.message}>{children}</section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

export function ReportLocked({ page }: Readonly<{ page: ReportLockedData }>) {
  return (
    <Locked>
      {page.kind === "unknown" ? (
        <>
          <h1>We cannot tell who is visiting right now</h1>
          <p>
            This report opens for the address it is filed under, and the part of the site that knows
            who is signed in did not answer. Nothing is wrong with the report. Try again in a
            moment.
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
          <h1>This report is not filed under {page.email}</h1>
          <p>
            A report opens for the address it was asked for with. If that is another address of
            yours, sign out and sign in with it.
          </p>
        </>
      ) : (
        <>
          <h1>Private report access required</h1>
          <p>
            This report opens for the address it is filed under. Sign in with that address and open
            this page again; the link that was sent after the scan does both.
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
    <Locked doors={false}>
      <h1>We cannot tell who is visiting right now</h1>
      <p>
        The part of the site that knows who is signed in did not answer, so we cannot tell which
        report is yours. Try again in a moment.
      </p>
      <SiteLink className="button button-primary" to="/report/latest">
        Try again
      </SiteLink>
    </Locked>
  );
}
