import {
  type ConsentSnapshot,
  consentAllowsMeasurement,
  readCurrentConsent,
} from "@agentify/analytics/browser";
import type { Segment } from "@agentify/scanner-contracts";
import { useCallback, useEffect, useRef } from "react";
import { useLocation } from "react-router";

import type { PendingEvent } from "../lib/analytics-delivery";
import { captureLandingAttribution } from "../lib/attribution-client";
import { readLandingAnnouncement } from "../lib/landing-announcement";

export type BrowserAnalyticsConfig = Readonly<{
  runtimeEnvironment: "local" | "test" | "preview" | "production";
  posthog: Readonly<{
    key: string | null;
    host: string | null;
    destinationEnvironment: "local" | "test" | "preview" | "production";
  }>;
  meta: Readonly<{
    pixelId: string | null;
    destinationEnvironment: "local" | "test" | "preview" | "production";
  }>;
}>;

export function AnalyticsRuntime({ config }: Readonly<{ config: BrowserAnalyticsConfig }>) {
  const { pathname } = useLocation();
  const consent = useRef<ConsentSnapshot | undefined>(undefined);

  const track = useCallback(
    async (event: PendingEvent) => {
      const snapshot = consent.current;
      // Nothing is recorded of a visit its visitor has not allowed measuring,
      // so the routes are not asked and the code that would ask them is not
      // even fetched; a choice made later tracks the landing then.
      if (!snapshot || !consentAllowsMeasurement(snapshot.categories)) return;
      let delivery: typeof import("../lib/analytics-delivery");
      try {
        delivery = await import("../lib/analytics-delivery");
      } catch {
        // Not fetched, so not recorded: the next page's trigger tries again.
        return;
      }
      await delivery.deliver(config, event, snapshot);
    },
    [config],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the route is what re-reads the stored consent snapshot, so a choice made on another page is not carried into this one
  useEffect(() => {
    consent.current = readCurrentConsent(window.localStorage);
    const changed = (event: Event) => {
      const snapshot = (event as CustomEvent<ConsentSnapshot>).detail;
      consent.current = snapshot;
      // A choice that allows measurement records the landing of the page it
      // was made on, which went unrecorded before it. The event's once-key
      // keeps a later visit on the same day from recording it twice.
      const landing = readLandingAnnouncement(document);
      if (landing && consentAllowsMeasurement(snapshot.categories)) {
        void captureLandingAttribution(landing.segment, landing.variant).then(() =>
          track(landingView(landing.segment, landing.variant)),
        );
      }
    };
    window.addEventListener("agentify:consent-changed", changed);
    return () => window.removeEventListener("agentify:consent-changed", changed);
  }, [pathname, track]);

  useEffect(() => {
    const landing = readLandingAnnouncement(document);
    if (landing) {
      const { segment, variant: landingVariant } = landing;
      void captureLandingAttribution(segment, landingVariant).then(() =>
        track(landingView(segment, landingVariant)),
      );
    }
    const report = /^\/report\/([^/]+)$/.exec(pathname);
    const authorizedReportScanId = document
      .querySelector("[data-agentify-results-viewed-scan]")
      ?.getAttribute("data-agentify-results-viewed-scan");
    if (report?.[1] && authorizedReportScanId === report[1]) {
      void track({
        name: "results_viewed",
        onceKey: `results:${report[1]}`,
        scanId: report[1],
      });
    }
  }, [pathname, track]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ name?: string; scanId?: string }>).detail;
      if (
        (detail?.name !== "registration_started" && detail?.name !== "results_viewed") ||
        !detail.scanId
      )
        return;
      void track({
        name: detail.name,
        onceKey:
          detail.name === "registration_started"
            ? `registration:${detail.scanId}`
            : `results:${detail.scanId}`,
        scanId: detail.scanId,
      });
    };
    window.addEventListener("agentify:analytics-event", listener);
    return () => window.removeEventListener("agentify:analytics-event", listener);
  }, [track]);

  return null;
}

/** A landing seen, once a day per variant. */
const landingView = (segment: Segment, landingVariant: string): PendingEvent => ({
  name: "landing_view",
  onceKey: `landing:${landingVariant}:${new Date().toISOString().slice(0, 10)}`,
  segment,
  landingVariant,
});
