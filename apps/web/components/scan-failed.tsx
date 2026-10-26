import type { ScanStatusResponse, ScanStopReason } from "@agentify/scanner-contracts";

import type { ScanAgain } from "../lib/pending-scan";
import { robotsHeadline } from "../lib/robots-notice";
import layout from "./result-layout.module.css";
import { RobotsNotice } from "./robots-notice";
import { SiteLink } from "./site-link";

// What the scanner knows stopped a scan, and what the person can do about it.
// Running the same address again meets the same stop, so these offer a new
// scan rather than a retry.
const STOPS: Readonly<Record<ScanStopReason, Readonly<{ headline: string; words: string }>>> = {
  no_public_site: {
    headline: "No public website answers at this address",
    words:
      "The address leads to no server on the public internet, or into a private network, so the scanner read nothing there. Check the address you entered.",
  },
  forbidden_redirect: {
    headline: "The site redirected the scanner where it does not go",
    words:
      "The scanner follows a redirect only to an address it would scan on its own, never down from HTTPS to HTTP, and at most five in a row. Scan the address the redirect should lead to.",
  },
  certificate_invalid: {
    headline: "The scanner could not verify the site's certificate",
    words:
      "The certificate may have expired, not cover this address, or lack its intermediate certificate. A browser may still open the site; most AI agents will not. Fix the certificate, then scan again.",
  },
};

/**
 * Why a scan ended without a result, and the way back to the form it came
 * from with its address filled in, to try again or to start anew.
 */
export function ScanFailed({
  again,
  blocked,
  checks,
  stopReason,
}: Readonly<{
  again: ScanAgain;
  blocked: boolean;
  checks: ScanStatusResponse["checks"];
  stopReason?: ScanStopReason;
}>) {
  const headline = robotsHeadline(checks);
  const stop = !headline && !blocked && stopReason ? STOPS[stopReason] : undefined;
  if (stop)
    return (
      <>
        <h1 data-stop-reason={stopReason}>{stop.headline}</h1>
        <p>{stop.words}</p>
        <SiteLink className="button button-primary" state={again.state} to={again.path}>
          Start a new scan
        </SiteLink>
      </>
    );
  return (
    <>
      <h1
        data-access-blocked={!headline && blocked ? "" : undefined}
        data-robots-headline={headline ?? undefined}
      >
        {headline === "disallowed"
          ? "Your robots.txt kept the scanner out"
          : headline === "unassessed"
            ? "The scanner could not assess your robots.txt"
            : blocked
              ? "The site turned the scanner away"
              : "No reliable diagnostic was produced"}
      </h1>
      <RobotsNotice checks={checks} className={layout.note} />
      {headline ? null : blocked ? (
        <p>
          The site answered the scanner with a bot challenge or a refusal, so no score is given.{" "}
          <a href="/docs/scanner#identity">How the scanner identifies itself</a>
        </p>
      ) : (
        <p>
          The scanner could read too little of the site for an honest result, for example after a
          timeout or a block.
        </p>
      )}
      <SiteLink className="button button-primary" state={again.state} to={again.path}>
        Try again
      </SiteLink>
    </>
  );
}
