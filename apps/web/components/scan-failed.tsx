import type { ScanStatusResponse, ScanStopReason } from "@agentify/scanner-contracts";

import { robotsHeadline } from "../lib/robots-notice";
import layout from "./result-layout.module.css";
import { RobotsNotice } from "./robots-notice";
import styles from "./scan-experience.module.css";
import { SiteLink } from "./site-link";

// What the scanner knows stopped a scan, and what the person can do about it.
// Running the same address again meets the same stop, so these offer a new
// scan rather than a retry.
const STOPS: Readonly<Record<ScanStopReason, Readonly<{ headline: string; words: string }>>> = {
  no_public_site: {
    headline: "No public website answers at this address",
    words:
      "The scanner reads only public websites. The name of this address, or of a page it redirects to, does not lead to one: it finds no server on the public internet or points into a private network, and the scanner requested nothing there. Check the address you entered; scanning it again gives the same answer.",
  },
  forbidden_redirect: {
    headline: "The site redirected the scanner where it does not go",
    words:
      "The scanner follows a redirect only to an address it would accept to scan on its own, never from HTTPS down to plain HTTP, and at most five in a row. This site's redirect breaks one of those rules, for example by leading to a bare IP address or an internal name. Check where the address redirects, or scan the address it should lead to.",
  },
  certificate_invalid: {
    headline: "The scanner did not accept the site's certificate",
    words:
      "The site's HTTPS certificate failed the checks a browser makes, for example because it has expired, is self-signed, or does not cover this address. Check the certificate, then scan the site again.",
  },
};

/** Why a scan ended without a result, and the way to try again or start anew. */
export function ScanFailed({
  blocked,
  checks,
  onRetry,
  stopReason,
}: Readonly<{
  blocked: boolean;
  checks: ScanStatusResponse["checks"];
  onRetry: () => void;
  stopReason?: ScanStopReason;
}>) {
  const headline = robotsHeadline(checks);
  const stop = !headline && !blocked && stopReason ? STOPS[stopReason] : undefined;
  if (stop)
    return (
      <div className={`${layout.message} ${styles.state}`}>
        <h1 data-stop-reason={stopReason}>{stop.headline}</h1>
        <p>{stop.words}</p>
        <SiteLink className="button button-primary" to="/">
          Start a new scan
        </SiteLink>
      </div>
    );
  return (
    <div className={`${layout.message} ${styles.state}`}>
      <h1
        data-access-blocked={!headline && blocked ? "" : undefined}
        data-robots-headline={headline ?? undefined}
      >
        {headline === "disallowed"
          ? "Your robots.txt kept the scanner out"
          : headline === "unassessed"
            ? "The scanner could not assess your robots.txt"
            : blocked
              ? "The site blocked our reader"
              : "No reliable diagnostic was produced"}
      </h1>
      <RobotsNotice checks={checks} className={layout.note} />
      {headline ? null : (
        <p>
          {blocked
            ? "The site answered the scanner's request for its home page with a bot challenge or a refusal. What could be read around it is what the site shows a reader it turns away, so no score is given."
            : "Coverage stayed below the minimum for an honest result. This can happen after a timeout, access block, or scanner failure."}
        </p>
      )}
      <button className="button button-primary" onClick={onRetry} type="button">
        Try again
      </button>
    </div>
  );
}
