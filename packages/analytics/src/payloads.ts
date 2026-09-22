import { createHash } from "node:crypto";
import type { AnalyticsEvent } from "./events.js";

export const META_EVENT_MAPPING = {
  landing_view: "PageView",
  scan_started: "ScanStart",
  scan_completed: "ScanComplete",
  results_viewed: "ViewContent",
  registration_started: "RegistrationStart",
  registration_completed: "CompleteRegistration",
  card_attached: "CardAttached",
  result_shared: "ResultShared",
} as const;

export const sha256NormalizedEmail = (email: string): string =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

export const buildPosthogPayload = (event: AnalyticsEvent, projectKey: string) => ({
  api_key: projectKey,
  event: event.name,
  properties: {
    distinct_id: event.pseudonymousId,
    $insert_id: event.eventId,
    $process_person_profile: false,
    segment: event.segment,
    landing_variant: event.landingVariant,
    ...event.properties,
  },
  timestamp: event.occurredAt,
});

export const POSTHOG_BROWSER_OPTIONS = {
  autocapture: false,
  disable_session_recording: true,
  capture_pageview: false,
  capture_pageleave: false,
  person_profiles: "never",
} as const;

export type MetaUserContext = {
  externalId: string;
  emailSha256?: string;
  fbp?: string;
  fbc?: string;
  clientIpAddress?: string;
  clientUserAgent?: string;
  allowHashedEmail: boolean;
  allowTransientNetworkData: boolean;
};

export const buildMetaPayload = (
  event: AnalyticsEvent,
  context: MetaUserContext,
  testEventCode?: string,
) => {
  if (!/^[a-f0-9]{64}$/i.test(context.externalId))
    throw new Error("meta_external_id_must_be_sha256");
  if (context.emailSha256 && !/^[a-f0-9]{64}$/i.test(context.emailSha256)) {
    throw new Error("meta_email_must_be_sha256");
  }
  return {
    data: [
      {
        event_name: META_EVENT_MAPPING[event.name],
        event_time: Math.floor(Date.parse(event.occurredAt) / 1000),
        event_id: event.eventId,
        action_source: "website",
        user_data: {
          external_id: [context.externalId],
          ...(context.allowHashedEmail && context.emailSha256 ? { em: [context.emailSha256] } : {}),
          ...(context.allowTransientNetworkData && context.fbp ? { fbp: context.fbp } : {}),
          ...(context.allowTransientNetworkData && context.fbc ? { fbc: context.fbc } : {}),
          ...(context.allowTransientNetworkData && context.clientIpAddress
            ? { client_ip_address: context.clientIpAddress }
            : {}),
          ...(context.allowTransientNetworkData && context.clientUserAgent
            ? { client_user_agent: context.clientUserAgent }
            : {}),
        },
        custom_data: {
          segment: event.segment,
          landing_variant: event.landingVariant,
          ...event.properties,
        },
      },
    ],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };
};

export const buildMetaPixelCommand = (event: AnalyticsEvent) => ({
  method: ["landing_view", "results_viewed", "registration_completed"].includes(event.name)
    ? "track"
    : "trackCustom",
  eventName: META_EVENT_MAPPING[event.name],
  parameters: {
    segment: event.segment,
    landing_variant: event.landingVariant,
    ...event.properties,
  },
  options: { eventID: event.eventId },
});
