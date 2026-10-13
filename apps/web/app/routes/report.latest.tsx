import { type LoaderFunctionArgs, type MetaArgs, redirect, redirectDocument } from "react-router";

import { LatestReportUnknown } from "../../components/report-locked";
import { privatePageMeta, siteConfigOf } from "../../lib/page-meta";
import { latestReportOf, visitorOf } from "../../lib/server/auth";

/**
 * The dashboard sends a signed-in person who owns no merchant here when their
 * link had no destination of its own, because the scanner knows whether they
 * own a report. Someone who does opens the latest one, never a screen offering
 * to make a merchant; someone who owns none goes back to the dashboard, and a
 * stranger to its sign-in. The dashboard is another process on this origin, so
 * the browser loads it as a document rather than looking for it among the
 * scanner's pages.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "stranger") throw redirectDocument("/dashboard/sign-in", 307);
  if (visitor.kind === "person") {
    const latest = visitor.leadId === null ? undefined : await latestReportOf(visitor.leadId);
    if (latest === undefined) throw redirectDocument("/dashboard/", 307);
    throw redirect(`/report/${encodeURIComponent(latest)}`, 307);
  }
  return null;
};

export const meta = ({ matches }: MetaArgs) =>
  privatePageMeta(siteConfigOf(matches), "Your latest report");

export default function LatestReportRoute() {
  return <LatestReportUnknown />;
}
