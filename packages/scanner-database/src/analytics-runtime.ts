import { createHash } from "node:crypto";

import {
  buildMetaPayload,
  buildOutboxInserts,
  buildPosthogPayload,
  type ConsentCategories,
  type ConsentEnvironment,
  createAnalyticsEvent,
  DEFAULT_CONSENT,
  eventOnceKey,
} from "@agentify/analytics";
import type { AnalyticsEventName, Segment } from "@agentify/scanner-contracts";
import { eq } from "drizzle-orm";

import {
  type BusinessEventExecutor,
  insertBusinessEventOnce,
} from "./analytics-event-store.js";
import { createUuidV7 } from "./ids.js";
import { consentSnapshots, sessions } from "./schema.js";

type StoredBusinessEventInput = {
  eventId?: string;
  name: AnalyticsEventName;
  identifiers: Readonly<Record<string, string>>;
  sessionId: string;
  consentSnapshotId: string;
  leadId?: string;
  scanId?: string;
  segment: Segment;
  landingVariant: string;
  properties?: Readonly<Record<string, unknown>>;
  occurredAt?: Date;
};

const environment = (value: string | undefined): ConsentEnvironment =>
  value === "test" || value === "preview" || value === "production"
    ? value
    : "local";

const enabled = (value: string | undefined): boolean => value === "true";

export async function emitStoredBusinessEvent(
  executor: BusinessEventExecutor,
  input: StoredBusinessEventInput,
): Promise<{ inserted: boolean; eventId: string }> {
  const [session, consentRow] = await Promise.all([
    executor
      .select({ anonymousIdHash: sessions.anonymousIdHash })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .limit(1)
      .then((rows) => rows[0]),
    executor
      .select({
        categories: consentSnapshots.categories,
        policyVersion: consentSnapshots.policyVersion,
        country: consentSnapshots.country,
      })
      .from(consentSnapshots)
      .where(eq(consentSnapshots.id, input.consentSnapshotId))
      .limit(1)
      .then((rows) => rows[0]),
  ]);
  if (!session || !consentRow) throw new Error("analytics_context_missing");

  const categories = {
    ...DEFAULT_CONSENT,
    ...(consentRow.categories as Partial<ConsentCategories>),
  };
  const runtimeEnvironment = environment(process.env.ANALYTICS_RUNTIME_ENV);
  const serverDeliveryEnabled = enabled(
    process.env.ANALYTICS_SERVER_DELIVERY_ENABLED,
  );
  const posthogConfigured = Boolean(process.env.POSTHOG_API_KEY);
  const metaConfigured =
    enabled(process.env.META_CAPI_ENABLED) &&
    Boolean(process.env.META_ACCESS_TOKEN) &&
    Boolean(process.env.META_DATASET_ID);

  if (
    serverDeliveryEnabled &&
    posthogConfigured &&
    environment(process.env.POSTHOG_DESTINATION_ENV) !== runtimeEnvironment
  ) {
    throw new Error("posthog_environment_mismatch");
  }
  if (
    serverDeliveryEnabled &&
    metaConfigured &&
    environment(process.env.META_DESTINATION_ENV) !== runtimeEnvironment
  ) {
    throw new Error("meta_environment_mismatch");
  }

  const event = createAnalyticsEvent({
    eventId: input.eventId ?? createUuidV7(),
    name: input.name,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    pseudonymousId: session.anonymousIdHash,
    segment: input.segment,
    landingVariant: input.landingVariant,
    properties: input.properties,
  });
  const effectiveConsent = {
    policyVersion: consentRow.policyVersion,
    ...(consentRow.country ? { country: consentRow.country } : {}),
    capturedAt: event.occurredAt,
    source: "api" as const,
    categories: {
      ...categories,
      product_analytics:
        categories.product_analytics &&
        serverDeliveryEnabled &&
        posthogConfigured,
      ads_measurement:
        categories.ads_measurement && serverDeliveryEnabled && metaConfigured,
    },
  };
  const externalId = createHash("sha256")
    .update(session.anonymousIdHash)
    .digest("hex");
  const outbox = buildOutboxInserts({
    event,
    consent: effectiveConsent,
    posthogPayload: buildPosthogPayload(
      event,
      process.env.POSTHOG_API_KEY ?? "disabled",
    ),
    metaPayload: buildMetaPayload(
      event,
      {
        externalId,
        allowHashedEmail: false,
        allowTransientNetworkData: false,
      },
      process.env.META_TEST_EVENT_CODE,
    ),
  });
  return await insertBusinessEventOnce(executor, {
    onceKey: eventOnceKey(event.name, input.identifiers),
    event,
    context: {
      sessionId: input.sessionId,
      consentSnapshotId: input.consentSnapshotId,
      ...(input.leadId ? { leadId: input.leadId } : {}),
      ...(input.scanId ? { scanId: input.scanId } : {}),
    },
    outbox,
  });
}
