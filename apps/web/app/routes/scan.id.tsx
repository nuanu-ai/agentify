import { isSegment } from "@agentify/scanner-contracts/browser";
import { type LoaderFunctionArgs, type MetaArgs, useLoaderData } from "react-router";

import { ScanExperience } from "../../components/scan-experience";
import { pageMeta, siteConfigOf } from "../../lib/page-meta";
import { scanFixture } from "../../lib/scan-fixtures";
import { getServerConfig } from "../../lib/server/config";

/** A query parameter given once, or null where it is absent or repeated. */
const once = (query: URLSearchParams, name: string): string | null => {
  const given = query.getAll(name);
  return given.length === 1 ? (given[0] ?? null) : null;
};

/**
 * A private scan's page. The scan itself is read by the browser from the API
 * with the token its link carried, so the page holds only the switches that
 * say what the result may offer, and the segment the scan was started from,
 * which names one step of its progress. Outside production `?fixture=<name>`
 * draws an example state instead of asking for a scan.
 */
export const loader = ({ url, params }: LoaderFunctionArgs) => {
  const config = getServerConfig();
  const segment = once(url.searchParams, "segment");
  return {
    scanId: params.id ?? "",
    browserObservationsEnabled: config.APIFY_BROWSER_MODE === "report",
    publicShareEnabled: config.PUBLIC_SHARE_ENABLED,
    remediationPromptEnabled: config.REMEDIATION_PROMPT_ENABLED,
    registrationEnabled: config.REGISTRATION_ENABLED,
    segment: isSegment(segment) ? segment : "owner",
    fixture: config.production ? null : scanFixture(once(url.searchParams, "fixture")),
  };
};

export const meta = ({ matches }: MetaArgs) =>
  pageMeta(siteConfigOf(matches), {
    title: "Private scan progress",
    robots: "noindex, nofollow",
    referrer: "no-referrer",
  });

export default function ScanRoute() {
  return <ScanExperience {...useLoaderData<typeof loader>()} />;
}
