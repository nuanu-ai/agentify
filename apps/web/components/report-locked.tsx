import { Brand } from "./brand";
import styles from "./report-page.module.css";
import { SiteDoors } from "./site-chrome";
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

/** The top of every report page: the brand, and the header's doors with who is signed in. */
export function ReportTop() {
  return (
    <div className={styles.top}>
      <Brand />
      <SiteDoors />
    </div>
  );
}

export function ReportLocked({ page }: Readonly<{ page: ReportLockedData }>) {
  return (
    <main className={styles.page}>
      <ReportTop />
      <section className={styles.locked}>
        {page.kind === "unknown" ? (
          <>
            <h1>We cannot tell who is visiting right now</h1>
            <p>
              This report opens for the address it is filed under, and the part of the site that
              knows who is signed in did not answer. Nothing is wrong with the report. Try again in
              a moment.
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
              This report opens for the address it is filed under. Sign in with that address and
              open this page again; the link that was sent after the scan does both.
            </p>
            <a className="button button-primary" href="/dashboard/sign-in">
              Sign in
            </a>
          </>
        )}
      </section>
    </main>
  );
}

/**
 * What `/report/latest` draws when the part of the site that knows who is
 * signed in did not answer; every other visitor is sent on before a page is
 * drawn.
 */
export function LatestReportUnknown() {
  return (
    <main className={styles.page}>
      <Brand />
      <section className={styles.locked}>
        <h1>We cannot tell who is visiting right now</h1>
        <p>
          The part of the site that knows who is signed in did not answer, so we cannot tell which
          report is yours. Try again in a moment.
        </p>
        <SiteLink className="button button-primary" to="/report/latest">
          Try again
        </SiteLink>
      </section>
    </main>
  );
}
