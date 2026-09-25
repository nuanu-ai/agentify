import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const utcTimestamp = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const uuidV7Check = (column: AnyPgColumn) => sql`substring(${column}::text, 15, 1) = '7'`;

export const merchantApplications = pgTable(
  "merchant_applications",
  {
    id: uuid("id").primaryKey(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    payloadCiphertext: text("payload_ciphertext").notNull(),
    policyVersion: text("policy_version").notNull(),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    expiresAt: utcTimestamp("expires_at").notNull(),
  },
  (table) => [
    check("merchant_applications_id_uuidv7", uuidV7Check(table.id)),
    uniqueIndex("merchant_applications_idempotency_uidx").on(table.idempotencyKeyHash),
    index("merchant_applications_expiry_idx").on(table.expiresAt),
  ],
);

export const segmentEnum = pgEnum("segment", ["store", "owner", "local"]);
export const scanStatusEnum = pgEnum("scan_status", [
  "accepted",
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
]);
export const checkStatusEnum = pgEnum("check_status", [
  "pending",
  "running",
  "pass",
  "partial",
  "fail",
  "unavailable",
  "not_applicable",
]);
export const diagnosticLevelEnum = pgEnum("diagnostic_level", [
  "invisible",
  "readable",
  "callable_ready",
  "ahead_of_market",
  "incomplete",
]);
export const shareStatusEnum = pgEnum("share_status", ["published", "revoked"]);
export const paymentSignalStatusEnum = pgEnum("payment_signal_status", [
  "not_started",
  "setup_pending",
  "attached",
  "detached",
  "failed",
]);
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "processing",
  "delivered",
  "dead_letter",
]);
export const deliveryDestinationEnum = pgEnum("delivery_destination", [
  "posthog",
  "meta",
  "partner_tracker",
]);
export const webhookReceiptStatusEnum = pgEnum("webhook_receipt_status", [
  "received",
  "processed",
  "failed",
]);
export const browserObservationStatusEnum = pgEnum("browser_observation_status", [
  "queued",
  "starting",
  "running",
  "completed",
  "partial",
  "blocked",
  "failed",
  "budget_skipped",
]);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    anonymousIdHash: text("anonymous_id_hash").notNull(),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    lastSeenAt: utcTimestamp("last_seen_at").notNull().defaultNow(),
    firstLandingVariant: text("first_landing_variant"),
    firstUtmSource: text("first_utm_source"),
    firstUtmMedium: text("first_utm_medium"),
    firstUtmCampaign: text("first_utm_campaign"),
    firstUtmContent: text("first_utm_content"),
    firstUtmTerm: text("first_utm_term"),
    firstFbclidHash: text("first_fbclid_hash"),
    lastLandingVariant: text("last_landing_variant"),
    lastUtmSource: text("last_utm_source"),
    lastUtmMedium: text("last_utm_medium"),
    lastUtmCampaign: text("last_utm_campaign"),
    lastUtmContent: text("last_utm_content"),
    lastUtmTerm: text("last_utm_term"),
    lastFbclidHash: text("last_fbclid_hash"),
    geoCountry: text("geo_country"),
    consentSnapshotId: uuid("consent_snapshot_id"),
  },
  (table) => [
    check("sessions_id_uuidv7", uuidV7Check(table.id)),
    uniqueIndex("sessions_anonymous_id_hash_uidx").on(table.anonymousIdHash),
  ],
);

export const consentSnapshots = pgTable(
  "consent_snapshots",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    policyVersion: text("policy_version").notNull(),
    country: text("country"),
    categories: jsonb("categories").notNull(),
    capturedAt: utcTimestamp("captured_at").notNull().defaultNow(),
    source: text("source").notNull(),
  },
  (table) => [
    check("consent_snapshots_id_uuidv7", uuidV7Check(table.id)),
    index("consent_snapshots_session_captured_idx").on(table.sessionId, table.capturedAt),
  ],
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey(),
    supabaseUserId: uuid("supabase_user_id"),
    emailNormalizedCiphertext: text("email_normalized_ciphertext").notNull(),
    emailLookupHash: text("email_lookup_hash").notNull(),
    phoneE164Ciphertext: text("phone_e164_ciphertext"),
    phoneLookupHash: text("phone_lookup_hash"),
    role: text("role").notNull(),
    name: text("name"),
    volumeBucket: text("volume_bucket"),
    verifiedAt: utcTimestamp("verified_at"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    unsubscribedAt: utcTimestamp("unsubscribed_at"),
    deletionRequestedAt: utcTimestamp("deletion_requested_at"),
    anonymizedAt: utcTimestamp("anonymized_at"),
    dataAccessRequestedAt: utcTimestamp("data_access_requested_at"),
    firstSegment: segmentEnum("first_segment").notNull(),
    firstSessionId: uuid("first_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
  },
  (table) => [
    check("leads_id_uuidv7", uuidV7Check(table.id)),
    uniqueIndex("leads_email_lookup_hash_uidx").on(table.emailLookupHash),
    uniqueIndex("leads_supabase_user_id_uidx")
      .on(table.supabaseUserId)
      .where(sql`${table.supabaseUserId} is not null`),
    index("leads_verified_at_idx").on(table.verifiedAt),
    index("leads_retention_idx").on(table.verifiedAt, table.anonymizedAt, table.createdAt),
  ],
);

export const scans = pgTable(
  "scans",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    segment: segmentEnum("segment").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    submittedUrlRedacted: text("submitted_url_redacted").notNull(),
    canonicalTargetUrl: text("canonical_target_url").notNull(),
    submittedWithoutScheme: boolean("submitted_without_scheme").notNull().default(false),
    targetHost: text("target_host").notNull(),
    targetHash: text("target_hash").notNull(),
    status: scanStatusEnum("status").notNull().default("accepted"),
    attemptNo: smallint("attempt_no").notNull().default(1),
    acceptedAt: utcTimestamp("accepted_at").notNull().defaultNow(),
    queuedAt: utcTimestamp("queued_at"),
    startedAt: utcTimestamp("started_at"),
    workerHeartbeatAt: utcTimestamp("worker_heartbeat_at"),
    finishedAt: utcTimestamp("finished_at"),
    score: smallint("score"),
    coverage: numeric("coverage", { precision: 4, scale: 3 }),
    level: diagnosticLevelEnum("level"),
    applicableWeight: numeric("applicable_weight", { precision: 7, scale: 3 }),
    earnedWeight: numeric("earned_weight", { precision: 7, scale: 3 }),
    cacheHit: boolean("cache_hit").notNull().default(false),
    sourceScanId: uuid("source_scan_id").references((): AnyPgColumn => scans.id, {
      onDelete: "set null",
    }),
    failureCode: text("failure_code"),
    accessTokenHash: text("access_token_hash").notNull(),
    accessTokenExpiresAt: utcTimestamp("access_token_expires_at").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    idempotencyBodyHash: text("idempotency_body_hash").notNull(),
  },
  (table) => [
    check("scans_id_uuidv7", uuidV7Check(table.id)),
    check("scans_score_range", sql`${table.score} is null or ${table.score} between 0 and 100`),
    check(
      "scans_coverage_range",
      sql`${table.coverage} is null or ${table.coverage} between 0 and 1`,
    ),
    check("scans_attempt_range", sql`${table.attemptNo} between 1 and 2`),
    check(
      "scans_terminal_result_invariant",
      sql`(${table.status} not in ('completed', 'partial')) or (${table.score} is not null and ${table.coverage} is not null and ${table.finishedAt} is not null)`,
    ),
    check(
      "scans_completed_coverage_invariant",
      sql`${table.status} <> 'completed' or ${table.coverage} = 1.000`,
    ),
    check(
      "scans_partial_coverage_invariant",
      sql`${table.status} <> 'partial' or (${table.coverage} >= 0.300 and ${table.coverage} < 1.000)`,
    ),
    check(
      "scans_failed_level_invariant",
      sql`${table.status} <> 'failed' or (${table.score} is null and (${table.level} is null or ${table.level} = 'incomplete'))`,
    ),
    uniqueIndex("scans_session_idempotency_uidx").on(table.sessionId, table.idempotencyKeyHash),
    index("scans_target_accepted_idx").on(table.targetHash, table.acceptedAt),
    index("scans_status_accepted_idx").on(table.status, table.acceptedAt),
    index("scans_segment_finished_idx").on(table.segment, table.finishedAt),
  ],
);

/**
 * A request for the full report of one scan, from the form until it is
 * finished. A stranger's waits for its own link, whose session names it by
 * this id; a signed-in person's own is finished as it is written (ADR-0026 §2).
 */
export const registrationIntents = pgTable(
  "registration_intents",
  {
    id: uuid("id").primaryKey(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    emailNormalizedCiphertext: text("email_normalized_ciphertext").notNull(),
    emailLookupHash: text("email_lookup_hash").notNull(),
    phoneE164Ciphertext: text("phone_e164_ciphertext"),
    phoneLookupHash: text("phone_lookup_hash"),
    partnerClickIdCiphertext: text("partner_click_id_ciphertext"),
    role: text("role").notNull(),
    siteOwnershipClaim: boolean("site_ownership_claim").notNull().default(false),
    marketingEmailOptIn: boolean("marketing_email_opt_in").notNull().default(false),
    datasetReuseAcknowledged: boolean("dataset_reuse_acknowledged").notNull().default(false),
    expiresAt: utcTimestamp("expires_at").notNull(),
    consumedAt: utcTimestamp("consumed_at"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check("registration_intents_id_uuidv7", uuidV7Check(table.id)),
    check(
      "registration_intents_dataset_acknowledged",
      sql`${table.datasetReuseAcknowledged} = true`,
    ),
    index("registration_intents_expiry_idx").on(table.expiresAt),
  ],
);

export const scanChecks = pgTable(
  "scan_checks",
  {
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    checkId: smallint("check_id").notNull(),
    status: checkStatusEnum("status").notNull().default("pending"),
    nominalWeight: numeric("nominal_weight", {
      precision: 7,
      scale: 3,
    }).notNull(),
    applicableWeight: numeric("applicable_weight", {
      precision: 7,
      scale: 3,
    }).notNull(),
    earnedWeight: numeric("earned_weight", {
      precision: 7,
      scale: 3,
    }).notNull(),
    startedAt: utcTimestamp("started_at"),
    finishedAt: utcTimestamp("finished_at"),
    summaryCode: text("summary_code"),
    userImpactCode: text("user_impact_code"),
    fixCode: text("fix_code"),
    durationMs: integer("duration_ms"),
    evidence: jsonb("evidence").notNull().default({}),
    errorCode: text("error_code"),
  },
  (table) => [
    primaryKey({ columns: [table.scanId, table.checkId] }),
    check("scan_checks_id_range", sql`${table.checkId} between 1 and 18`),
    index("scan_checks_scan_status_idx").on(table.scanId, table.status),
  ],
);

export const scanSnapshots = pgTable(
  "scan_snapshots",
  {
    id: uuid("id").primaryKey(),
    cacheKey: text("cache_key").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    segmentProfile: text("segment_profile").notNull(),
    canonicalTargetUrl: text("canonical_target_url").notNull(),
    checks: jsonb("checks").notNull(),
    fingerprint: jsonb("fingerprint").notNull(),
    score: smallint("score").notNull(),
    coverage: numeric("coverage", { precision: 4, scale: 3 }).notNull(),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    invalidatedAt: utcTimestamp("invalidated_at"),
  },
  (table) => [
    check("scan_snapshots_id_uuidv7", uuidV7Check(table.id)),
    check("scan_snapshots_score_range", sql`${table.score} between 0 and 100`),
    check("scan_snapshots_coverage_range", sql`${table.coverage} between 0 and 1`),
    uniqueIndex("scan_snapshots_cache_key_uidx").on(table.cacheKey),
  ],
);

export const scanFingerprints = pgTable("scan_fingerprints", {
  scanId: uuid("scan_id")
    .primaryKey()
    .references(() => scans.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  platformConfidence: text("platform_confidence").notNull(),
  cmsVersion: text("cms_version"),
  versionConfidence: text("version_confidence"),
  wafCdn: text("waf_cdn").array().notNull().default(sql`'{}'::text[]`),
  pspMarkers: text("psp_markers").array().notNull().default(sql`'{}'::text[]`),
  feedSignals: text("feed_signals").array().notNull().default(sql`'{}'::text[]`),
  headerSignals: jsonb("header_signals").notNull().default({}),
  htmlSignals: jsonb("html_signals").notNull().default({}),
  detectorVersion: text("detector_version").notNull(),
});

export const browserObservations = pgTable(
  "browser_observations",
  {
    id: uuid("id").primaryKey(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    observationVersion: text("observation_version").notNull(),
    operationId: uuid("operation_id").notNull(),
    operationKey: text("operation_key").notNull(),
    status: browserObservationStatusEnum("status").notNull().default("queued"),
    actorId: text("actor_id").notNull(),
    actorBuild: text("actor_build").notNull(),
    apifyRunId: text("apify_run_id"),
    attemptNo: smallint("attempt_no").notNull().default(1),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: utcTimestamp("lease_expires_at"),
    queuedAt: utcTimestamp("queued_at").notNull().defaultNow(),
    startedAt: utcTimestamp("started_at"),
    finishedAt: utcTimestamp("finished_at"),
    lastPolledAt: utcTimestamp("last_polled_at"),
    pagesAssessed: smallint("pages_assessed").notNull().default(0),
    requestCount: integer("request_count").notNull().default(0),
    transferredBytes: integer("transferred_bytes").notNull().default(0),
    durationMs: integer("duration_ms"),
    usageUsd: numeric("usage_usd", { precision: 10, scale: 6 }),
    budgetDay: date("budget_day", { mode: "string" }),
    budgetReservedUsd: numeric("budget_reserved_usd", {
      precision: 10,
      scale: 6,
    })
      .notNull()
      .default("0"),
    usageReconciledAt: utcTimestamp("usage_reconciled_at"),
    storageCleanedAt: utcTimestamp("storage_cleaned_at"),
    failureCode: text("failure_code"),
    signals: jsonb("signals"),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("browser_observations_id_uuidv7", uuidV7Check(table.id)),
    check("browser_observations_operation_id_uuidv7", uuidV7Check(table.operationId)),
    check("browser_observations_attempt_once", sql`${table.attemptNo} = 1`),
    check("browser_observations_pages_range", sql`${table.pagesAssessed} between 0 and 3`),
    check(
      "browser_observations_usage_nonnegative",
      sql`${table.usageUsd} is null or ${table.usageUsd} >= 0`,
    ),
    check(
      "browser_observations_budget_reservation_nonnegative",
      sql`${table.budgetReservedUsd} >= 0`,
    ),
    uniqueIndex("browser_observations_operation_key_uidx").on(table.operationKey),
    uniqueIndex("browser_observations_operation_id_uidx").on(table.operationId),
    uniqueIndex("browser_observations_scan_version_uidx").on(
      table.scanId,
      table.observationVersion,
    ),
    index("browser_observations_status_queued_idx").on(table.status, table.queuedAt),
    index("browser_observations_run_idx").on(table.apifyRunId),
  ],
);

export const browserObservationBudgetDays = pgTable(
  "browser_observation_budget_days",
  {
    budgetDay: date("budget_day", { mode: "string" }).primaryKey(),
    reservedUsd: numeric("reserved_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    usageUsd: numeric("usage_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("browser_observation_budget_days_reserved_nonnegative", sql`${table.reservedUsd} >= 0`),
    check("browser_observation_budget_days_usage_nonnegative", sql`${table.usageUsd} >= 0`),
  ],
);

export const browserObservationFindings = pgTable(
  "browser_observation_findings",
  {
    observationId: uuid("observation_id")
      .notNull()
      .references(() => browserObservations.id, { onDelete: "cascade" }),
    findingId: text("finding_id").notNull(),
    status: checkStatusEnum("status").notNull(),
    summaryCode: text("summary_code").notNull(),
    userImpactCode: text("user_impact_code"),
    remediationCode: text("remediation_code"),
    evidence: jsonb("evidence").notNull().default({}),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.observationId, table.findingId] }),
    check(
      "browser_observation_findings_terminal_status",
      sql`${table.status} not in ('pending', 'running')`,
    ),
    index("browser_observation_findings_status_idx").on(table.observationId, table.status),
  ],
);

export const leadScans = pgTable(
  "lead_scans",
  {
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    siteOwnershipClaim: boolean("site_ownership_claim").notNull().default(false),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.leadId, table.scanId] })],
);

export const scannerIdentityDeletionOperations = pgTable(
  "scanner_identity_deletion_operations",
  {
    operationId: uuid("operation_id").primaryKey(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    cabinetResult: text("cabinet_result"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: utcTimestamp("lease_expires_at"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    completedAt: utcTimestamp("completed_at"),
  },
  (table) => [
    check("scanner_identity_deletion_operations_id_uuidv7", uuidV7Check(table.operationId)),
    check(
      "scanner_identity_deletion_operations_result",
      sql`${table.cabinetResult} is null or ${table.cabinetResult} in ('deleted', 'already_absent', 'retained')`,
    ),
    check(
      "scanner_identity_deletion_operations_completion",
      sql`${table.completedAt} is null or ${table.cabinetResult} is not null`,
    ),
    uniqueIndex("scanner_identity_deletion_operations_lead_uidx").on(table.leadId),
    index("scanner_identity_deletion_operations_pending_idx")
      .on(table.leaseExpiresAt, table.createdAt)
      .where(sql`${table.completedAt} is null`),
  ],
);

/**
 * The record that a lead registered for a scan: registration writes one row
 * per lead and scan, the report opens only for a lead with one, and a person's
 * latest report is read through it. The name is the former product's, where the row was also
 * a place in a queue and carried a survey answer; those columns are gone
 * (docs/research/31-user-journey.md §3), and the rename is a step of its own.
 */
export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: uuid("id").primaryKey(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check("waitlist_entries_id_uuidv7", uuidV7Check(table.id)),
    uniqueIndex("waitlist_entries_lead_scan_uidx").on(table.leadId, table.scanId),
  ],
);

export const scanShares = pgTable(
  "scan_shares",
  {
    id: uuid("id").primaryKey(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    shareSlugHash: text("share_slug_hash").notNull(),
    status: shareStatusEnum("status").notNull().default("published"),
    publishedAt: utcTimestamp("published_at").notNull().defaultNow(),
    revokedAt: utcTimestamp("revoked_at"),
    allowIndexing: boolean("allow_indexing").notNull().default(false),
    publicSnapshot: jsonb("public_snapshot").notNull(),
  },
  (table) => [
    check("scan_shares_id_uuidv7", uuidV7Check(table.id)),
    uniqueIndex("scan_shares_slug_hash_uidx").on(table.shareSlugHash),
    uniqueIndex("scan_shares_one_active_uidx")
      .on(table.scanId)
      .where(sql`${table.status} = 'published'`),
  ],
);

export const paymentSignals = pgTable(
  "payment_signals",
  {
    id: uuid("id").primaryKey(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    setupIntentId: text("setup_intent_id").notNull(),
    paymentMethodIdCiphertext: text("payment_method_id_ciphertext"),
    status: paymentSignalStatusEnum("status").notNull().default("not_started"),
    attachedAt: utcTimestamp("attached_at"),
    detachedAt: utcTimestamp("detached_at"),
    consentSnapshotId: uuid("consent_snapshot_id")
      .notNull()
      .references(() => consentSnapshots.id, { onDelete: "restrict" }),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check("payment_signals_id_uuidv7", uuidV7Check(table.id)),
    uniqueIndex("payment_signals_setup_intent_uidx").on(table.setupIntentId),
  ],
);

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: uuid("id").primaryKey(),
    eventId: uuid("event_id").notNull(),
    onceKey: text("once_key"),
    name: text("name").notNull(),
    occurredAt: utcTimestamp("occurred_at").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    scanId: uuid("scan_id").references(() => scans.id, {
      onDelete: "set null",
    }),
    segment: segmentEnum("segment").notNull(),
    landingVariant: text("landing_variant").notNull(),
    properties: jsonb("properties").notNull().default({}),
    consentSnapshotId: uuid("consent_snapshot_id")
      .notNull()
      .references(() => consentSnapshots.id, { onDelete: "restrict" }),
  },
  (table) => [
    check("analytics_events_id_uuidv7", uuidV7Check(table.id)),
    check("analytics_events_event_id_uuidv7", uuidV7Check(table.eventId)),
    uniqueIndex("analytics_events_event_id_uidx").on(table.eventId),
    uniqueIndex("analytics_events_once_key_uidx").on(table.onceKey),
    uniqueIndex("analytics_events_registration_business_uidx")
      .on(table.leadId, table.scanId, table.name)
      .where(sql`${table.name} = 'registration_completed'`),
    index("analytics_events_name_occurred_idx").on(table.name, table.occurredAt),
    index("analytics_events_segment_name_occurred_idx").on(
      table.segment,
      table.name,
      table.occurredAt,
    ),
  ],
);

export const deliveryOutbox = pgTable(
  "delivery_outbox",
  {
    id: uuid("id").primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => analyticsEvents.eventId, { onDelete: "cascade" }),
    destination: deliveryDestinationEnum("destination").notNull(),
    payload: jsonb("payload").notNull(),
    status: outboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: utcTimestamp("next_attempt_at").notNull().defaultNow(),
    lastErrorCode: text("last_error_code"),
    deliveredAt: utcTimestamp("delivered_at"),
  },
  (table) => [
    check("delivery_outbox_id_uuidv7", uuidV7Check(table.id)),
    check("delivery_outbox_attempts_nonnegative", sql`${table.attempts} >= 0`),
    uniqueIndex("delivery_outbox_event_destination_uidx").on(table.eventId, table.destination),
    index("delivery_outbox_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
  ],
);

export const webhookReceipts = pgTable(
  "webhook_receipts",
  {
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    receivedAt: utcTimestamp("received_at").notNull().defaultNow(),
    processedAt: utcTimestamp("processed_at"),
    status: webhookReceiptStatusEnum("status").notNull().default("received"),
  },
  (table) => [primaryKey({ columns: [table.provider, table.providerEventId] })],
);

export const rateWindows = pgTable(
  "rate_windows",
  {
    keyHash: text("key_hash").notNull(),
    windowStart: utcTimestamp("window_start").notNull(),
    kind: text("kind").notNull(),
    count: integer("count").notNull().default(0),
    challengePassedCount: integer("challenge_passed_count").notNull().default(0),
    expiresAt: utcTimestamp("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.keyHash, table.windowStart, table.kind] }),
    check("rate_windows_count_nonnegative", sql`${table.count} >= 0`),
    check("rate_windows_challenge_count_nonnegative", sql`${table.challengePassedCount} >= 0`),
    index("rate_windows_expires_idx").on(table.expiresAt),
  ],
);

export const rateLimitEvents = pgTable(
  "rate_limit_events",
  {
    id: uuid("id").primaryKey(),
    keyHash: text("key_hash").notNull(),
    kind: text("kind").notNull(),
    occurredAt: utcTimestamp("occurred_at").notNull().defaultNow(),
    challengePassed: boolean("challenge_passed").notNull().default(false),
    expiresAt: utcTimestamp("expires_at").notNull(),
  },
  (table) => [
    check("rate_limit_events_id_uuidv7", uuidV7Check(table.id)),
    index("rate_limit_events_lookup_idx").on(table.keyHash, table.kind, table.occurredAt),
    index("rate_limit_events_expires_idx").on(table.expiresAt),
  ],
);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  service: text("service").notNull(),
  startedAt: utcTimestamp("started_at").notNull(),
  heartbeatAt: utcTimestamp("heartbeat_at").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
});
