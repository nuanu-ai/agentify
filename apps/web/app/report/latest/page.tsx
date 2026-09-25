import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Brand } from "../../../components/brand";
import { latestReportOf, visitorOf } from "../../../lib/server/auth";
import styles from "../[scanId]/report.module.css";

export const metadata: Metadata = {
  title: "Your latest report",
  robots: { index: false, follow: false },
};

/**
 * Where a person who owns no merchant starts (ADR-0026 §1).
 *
 * The cabinet sends a signed-in person without a merchant here when their
 * link had no destination of its own, because the scanner is what knows
 * whether they own a report: somebody who does opens the latest of them,
 * never a screen offering to make a merchant, and somebody who owns none goes
 * back to the cabinet. A stranger is sent to sign in.
 */
export default async function LatestReportPage() {
  const visitor = await visitorOf((await headers()).get("cookie"));
  if (visitor.kind === "stranger") redirect("/cabinet/sign-in");
  if (visitor.kind === "person") {
    const latest = visitor.leadId === null ? undefined : await latestReportOf(visitor.leadId);
    redirect(latest === undefined ? "/cabinet/" : `/report/${encodeURIComponent(latest)}`);
  }
  return (
    <main className={styles.page}>
      <Brand />
      <section className={styles.locked}>
        <h1>We cannot tell who is visiting right now</h1>
        <p>
          The part of the site that knows who is signed in did not answer, so we cannot tell which
          report is yours. Try again in a moment.
        </p>
        <Link className="button button-primary" href="/report/latest">
          Try again
        </Link>
      </section>
    </main>
  );
}
