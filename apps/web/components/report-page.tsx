import { Brand } from "./brand";
import styles from "./report-page.module.css";
import { SiteLink } from "./site-link";

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
