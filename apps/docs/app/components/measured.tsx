import {
  type ConsentSnapshot,
  consentAllowsMeasurement,
  readCurrentConsent,
} from "@agentify/analytics/browser";
import { CONSENT_CHANGED_EVENT } from "@agentify/consent";
import { useEffect } from "react";
import { useLocation } from "react-router";
import { servedValues } from "../served.js";
import { analyticsConfigIn } from "../site-values.js";

/**
 * Records a view of each page a visitor reads, once they allowed measuring:
 * the page they were on when they chose, and every page after it, a move
 * without a reload included. Each service a choice allows counts a page once,
 * under the address it was read at, however often the choice is saved again.
 * Nothing is fetched or sent before a choice that allows it, and where the
 * document was served without its settings filled, or with one the scanner
 * would refuse, nothing is sent at all.
 */
export function Measured({ built }: Readonly<{ built: string }>) {
  const { pathname } = useLocation();

  // biome-ignore lint/correctness/useExhaustiveDependencies: each page the visitor moves to is a view of its own
  useEffect(() => {
    const values = servedValues(built);
    const config = values === null ? null : analyticsConfigIn(values);
    const address = window.location.href;
    const counted = { product_analytics: false, ads_measurement: false };
    const record = (snapshot: ConsentSnapshot | undefined) => {
      if (config === null || snapshot === undefined) return;
      const unsent: ConsentSnapshot = {
        ...snapshot,
        categories: {
          ...snapshot.categories,
          product_analytics: snapshot.categories.product_analytics && !counted.product_analytics,
          ads_measurement: snapshot.categories.ads_measurement && !counted.ads_measurement,
        },
      };
      if (!consentAllowsMeasurement(unsent.categories)) return;
      counted.product_analytics ||= unsent.categories.product_analytics;
      counted.ads_measurement ||= unsent.categories.ads_measurement;
      void import("../page-view.js")
        .then(({ sendPageView }) => sendPageView(config, unsent, address))
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
