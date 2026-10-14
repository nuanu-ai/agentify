import {
  type ConsentSnapshot,
  consentAllowsMeasurement,
  readCurrentConsent,
} from "@agentify/analytics/browser";
import { type BrowserAnalyticsConfig, CONSENT_CHANGED_EVENT } from "@agentify/consent";
import { useEffect } from "react";
import { useLocation } from "react-router";
import { servedValues } from "../served.js";
import type { SiteValues } from "../site-values.js";

const ENVIRONMENTS = ["local", "test", "preview", "production"] as const;

const environmentOf = (written: string): (typeof ENVIRONMENTS)[number] =>
  ENVIRONMENTS.find((each) => each === written) ?? "local";

/** Where measurements go, from the settings Caddy filled in as the scanner is given them. */
export const analyticsConfigOf = (values: SiteValues): BrowserAnalyticsConfig => ({
  runtimeEnvironment: environmentOf(values["analytics-runtime"]),
  posthog: {
    key: values["posthog-key"] || null,
    host: values["posthog-host"] || null,
    destinationEnvironment: environmentOf(values["posthog-destination"]),
  },
  meta: {
    pixelId: values["meta-pixel"] || null,
    destinationEnvironment: environmentOf(values["meta-destination"]),
  },
});

/**
 * Records a view of each page a visitor reads, once they allowed measuring:
 * the page they were on when they chose, and every page after it, a move
 * without a reload included. Nothing is fetched or sent before a choice that
 * allows it, and where the document was served without its settings filled
 * nothing is sent at all.
 */
export function Measured({ built }: Readonly<{ built: string }>) {
  const { pathname } = useLocation();

  // biome-ignore lint/correctness/useExhaustiveDependencies: each page the visitor moves to is a view of its own
  useEffect(() => {
    const values = servedValues(built);
    const record = (snapshot: ConsentSnapshot | undefined) => {
      if (values === null || snapshot === undefined) return;
      if (!consentAllowsMeasurement(snapshot.categories)) return;
      const config = analyticsConfigOf(values);
      void import("../page-view.js")
        .then(({ sendPageView }) => sendPageView(config, snapshot, window.location.href))
        .catch(() => {
          // Not fetched, so not recorded: the next page tries again.
        });
    };
    // Read on every page, so a choice made on another of the site's pages holds here.
    record(readCurrentConsent(window.localStorage));
    const changed = (event: Event) => record((event as CustomEvent<ConsentSnapshot>).detail);
    window.addEventListener(CONSENT_CHANGED_EVENT, changed);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, changed);
  }, [built, pathname]);

  return null;
}
