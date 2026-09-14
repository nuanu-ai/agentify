"use client";

import {
  readCurrentConsent,
  type ConsentSnapshot,
} from "@b2a/analytics/browser";
import type { AnalyticsEventName, Segment } from "@b2a/contracts";
import type { PostHog } from "posthog-js";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

import {
  createClientOwnedEventId,
  dispatchConsentedBrowserEvent,
  recordThenDeliverWithConsent,
} from "../lib/analytics-client";
import { captureLandingAttribution } from "../lib/attribution-client";

type ClientEventName = Extract<
  AnalyticsEventName,
  "landing_view" | "results_viewed" | "registration_started"
>;
type PendingEvent = {
  name: ClientEventName;
  onceKey: string;
  scanId?: string;
  segment?: Segment;
  landingVariant?: string;
};

const runtimeEnvironment = process.env.NEXT_PUBLIC_ANALYTICS_ENV ?? "local";
const META_CLIENT_EVENT = {
  landing_view: "PageView",
  results_viewed: "ViewContent",
  registration_started: "RegistrationStart",
} as const;

export function AnalyticsRuntime() {
  const pathname = usePathname();
  const consent = useRef<ConsentSnapshot | undefined>(undefined);

  const track = useCallback(async (event: PendingEvent) => {
    const snapshot = consent.current;
    const eventIdKey = `b2a.analytics.event-id.${event.onceKey}`;
    const candidateEventId =
      window.sessionStorage.getItem(eventIdKey) ??
      createClientOwnedEventId(event.name);
    window.sessionStorage.setItem(eventIdKey, candidateEventId);
    const scanToken = event.scanId
      ? window.sessionStorage.getItem(`b2a:scan-token:${event.scanId}`)
      : null;
    try {
      await recordThenDeliverWithConsent({
        consent: snapshot,
        recordBusinessEvent: async () => {
          const response = await fetch("/api/v1/events", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(scanToken ? { Authorization: `Bearer ${scanToken}` } : {}),
            },
            body: JSON.stringify({
              event_id: candidateEventId,
              name: event.name,
              ...(event.scanId ? { scan_id: event.scanId } : {}),
              ...(event.segment ? { segment: event.segment } : {}),
              ...(event.landingVariant
                ? { landing_variant: event.landingVariant }
                : {}),
              properties: {},
            }),
          });
          if (!response.ok) throw new Error("analytics_record_failed");
          const result = (await response.json()) as {
            event_id: string;
            segment: Segment;
            landing_variant: string;
          };
          window.sessionStorage.setItem(eventIdKey, result.event_id);
          return result;
        },
        deliverToBrowserDestinations: async (result, allowedConsent) => {
          await dispatchConsentedBrowserEvent({
            eventId: result.event_id,
            onceKey: `${event.onceKey}:${result.event_id}`,
            consent: allowedConsent,
            storage: window.localStorage,
            sendPosthog: async (eventId) =>
              sendPosthog(
                event.name,
                eventId,
                result.segment,
                result.landing_variant,
              ),
            sendMetaPixel: async (eventId) =>
              sendMetaPixel(
                event.name,
                eventId,
                result.segment,
                result.landing_variant,
              ),
          });
        },
      });
    } catch {
      // A later route trigger/refresh can retry the server event. Browser
      // destination once-keys are stored only after their own successful send.
    }
  }, []);

  useEffect(() => {
    consent.current = readCurrentConsent(window.localStorage);
    const changed = (event: Event) => {
      const snapshot = (event as CustomEvent<ConsentSnapshot>).detail;
      consent.current = snapshot;
      const landing = /^\/(store|owner|local)$/.exec(pathname);
      if (snapshot.categories.ads_measurement && landing) {
        const segment = landing[1] as Segment;
        void captureLandingAttribution(segment, `${segment}-v1`);
      }
    };
    window.addEventListener("b2a:consent-changed", changed);
    return () => window.removeEventListener("b2a:consent-changed", changed);
  }, [pathname]);

  useEffect(() => {
    const landing = /^\/(store|owner|local)$/.exec(pathname);
    if (landing) {
      const segment = landing[1] as Segment;
      const landingVariant = `${segment}-v1`;
      void captureLandingAttribution(segment, landingVariant).then(() =>
        track({
          name: "landing_view",
          onceKey: `landing:${landingVariant}:${new Date().toISOString().slice(0, 10)}`,
          segment,
          landingVariant,
        }),
      );
    }
    const report = /^\/report\/([^/]+)$/.exec(pathname);
    const authorizedReportScanId = document
      .querySelector("[data-b2a-results-viewed-scan]")
      ?.getAttribute("data-b2a-results-viewed-scan");
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
      const detail = (event as CustomEvent<{ name?: string; scanId?: string }>)
        .detail;
      if (
        (detail?.name !== "registration_started" &&
          detail?.name !== "results_viewed") ||
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
    window.addEventListener("b2a:analytics-event", listener);
    return () => window.removeEventListener("b2a:analytics-event", listener);
  }, [track]);

  return null;
}

let posthogPromise: Promise<PostHog> | undefined;

async function sendPosthog(
  name: ClientEventName,
  eventId: string,
  segment: Segment,
  landingVariant: string,
) {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  const destination =
    process.env.NEXT_PUBLIC_POSTHOG_DESTINATION_ENV ?? "local";
  if (!key || !host || destination !== runtimeEnvironment) return;
  posthogPromise ??= import("posthog-js").then(({ default: posthog }) => {
    posthog.init(key, {
      api_host: host,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      person_profiles: "never",
    });
    return posthog;
  });
  const posthog = await posthogPromise;
  posthog.capture(name, {
    $insert_id: eventId,
    $process_person_profile: false,
    segment,
    landing_variant: landingVariant,
  });
}

type MetaWindow = Window & {
  fbq?: ((...args: unknown[]) => void) & {
    callMethod?: (...args: unknown[]) => void;
    queue?: unknown[][];
    loaded?: boolean;
    version?: string;
  };
  _fbq?: (...args: unknown[]) => void;
};

function ensureMetaPixel(): MetaWindow["fbq"] | undefined {
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const destination = process.env.NEXT_PUBLIC_META_DESTINATION_ENV ?? "local";
  if (!pixelId || destination !== runtimeEnvironment) return undefined;
  const target = window as MetaWindow;
  if (!target.fbq) {
    const fbq = ((...args: unknown[]) => {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue?.push(args);
    }) as NonNullable<MetaWindow["fbq"]>;
    fbq.queue = [];
    fbq.loaded = true;
    fbq.version = "2.0";
    target.fbq = fbq;
    target._fbq = fbq;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(script);
    fbq("init", pixelId);
  }
  return target.fbq;
}

async function sendMetaPixel(
  name: ClientEventName,
  eventId: string,
  segment: Segment,
  landingVariant: string,
) {
  const fbq = ensureMetaPixel();
  if (!fbq) return;
  fbq(
    name === "landing_view" || name === "results_viewed"
      ? "track"
      : "trackCustom",
    META_CLIENT_EVENT[name],
    { segment, landing_variant: landingVariant },
    { eventID: eventId },
  );
}
