import { z } from "zod";

import { uuidV7Schema } from "./api.js";
import { checkStatusSchema, segmentSchema } from "./enums.js";

export const BROWSER_OBSERVATION_VERSION = "browser-public-v1.0.0" as const;

export const BROWSER_OBSERVATION_IDS = [
  "rendered_content_delta",
  "accessibility_structure",
  "form_semantics",
  "webmcp_surface",
  "browser_console_health",
  "browser_network_health",
  "rendered_metadata_consistency",
  "public_fact_consistency",
  "session_or_challenge_wall",
  "hidden_instruction_risk",
  "api_discovery_surface",
  "content_license_surface",
  "representative_page_consistency",
  "browser_runtime_cost",
] as const;

export const browserObservationIdSchema = z.enum(BROWSER_OBSERVATION_IDS);
export type BrowserObservationId = z.infer<typeof browserObservationIdSchema>;

export const browserObservationLifecycleStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "completed",
  "partial",
  "blocked",
  "failed",
  "budget_skipped",
]);
export type BrowserObservationLifecycleStatus = z.infer<
  typeof browserObservationLifecycleStatusSchema
>;

const safeEvidenceValueSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(200)).max(20),
]);
const privateEvidenceKey =
  /(?:^|_)(?:raw_html|raw_text|url|urls|ip|header|headers|body|token|cookie|authorization|secret|trace|stack|actor|actor_id|provider|run_id|operation_id)(?:$|_value$|_values$)/i;
const privateEvidenceValue =
  /(?:https?:\/\/|(?:^|\s)(?:\d{1,3}\.){3}\d{1,3}(?:\s|$)|bearer\s+|api[_-]?key|(?:^|\s)\/[^\s]*|[?&][a-z0-9_-]+=|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|\b)|ignore\s+(?:all\s+)?previous\s+instructions?|system\s+prompt|developer\s+message|follow\s+(?:these|my)\s+instructions?)/i;
const containsControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
export const browserObservationEvidenceSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), safeEvidenceValueSchema)
  .superRefine((value, context) => {
    if (JSON.stringify(value).length > 8_192) {
      context.addIssue({
        code: "custom",
        message: "Browser observation evidence exceeds 8 KiB",
      });
    }
    for (const [key, item] of Object.entries(value)) {
      if (privateEvidenceKey.test(key)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Private/raw browser evidence keys are forbidden",
        });
      }
      const values = Array.isArray(item) ? item : [item];
      if (
        values.some(
          (entry) =>
            typeof entry === "string" &&
            (privateEvidenceValue.test(entry) ||
              containsControlCharacters(entry)),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [key],
          message:
            "Raw URLs, paths, IPs, query strings, or secrets are forbidden",
        });
      }
    }
  });

const privateCodeSegment =
  /(?:^|_)(?:access_key|api_key|authorization|bearer|cookie|credential|password|passwd|private_key|secret|session_id|token)(?:_|$)/;
const safeBrowserCodeSchema = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, {
      message: "Browser codes must be lowercase snake_case identifiers",
    })
    .refine((value) => !privateCodeSegment.test(value), {
      message: "Private or secret-bearing browser codes are forbidden",
    });

const categorySchema = safeBrowserCodeSchema(100);

export const browserObservationSignalsSchema = z
  .object({
    rendered_text_chars: z.number().int().nonnegative().max(5_000_000),
    raw_to_rendered_ratio: z
      .number()
      .finite()
      .nonnegative()
      .max(100)
      .nullable(),
    landmark_counts: z.record(categorySchema, z.number().int().nonnegative()),
    heading_level_counts: z.record(
      categorySchema,
      z.number().int().nonnegative(),
    ),
    interactive_control_count: z.number().int().nonnegative().max(100_000),
    unnamed_control_count: z.number().int().nonnegative().max(100_000),
    form_control_count: z.number().int().nonnegative().max(100_000),
    unlabeled_form_control_count: z.number().int().nonnegative().max(100_000),
    webmcp_present: z.boolean(),
    webmcp_tool_count: z.number().int().nonnegative().max(10_000),
    console_error_categories: z.array(categorySchema).max(20),
    failed_resource_categories: z.array(categorySchema).max(20),
    mixed_content_count: z.number().int().nonnegative().max(100_000),
    dom_node_count: z.number().int().nonnegative().max(5_000_000),
    script_count: z.number().int().nonnegative().max(100_000),
    request_count: z.number().int().nonnegative().max(1_000),
    transferred_bytes: z.number().int().nonnegative().max(100_000_000),
    challenge_kind: categorySchema.nullable(),
  })
  .strict();
export type BrowserObservationSignals = z.infer<
  typeof browserObservationSignalsSchema
>;

export const browserObservationFindingSchema = z
  .object({
    id: browserObservationIdSchema,
    status: checkStatusSchema.exclude(["pending", "running"]),
    summary_code: safeBrowserCodeSchema(200),
    user_impact_code: safeBrowserCodeSchema(200).optional(),
    remediation_code: safeBrowserCodeSchema(200).optional(),
    evidence: browserObservationEvidenceSchema,
  })
  .strict();
export type BrowserObservationFinding = z.infer<
  typeof browserObservationFindingSchema
>;

export const browserObservationInputV1Schema = z
  .object({
    schema_version: z.literal(BROWSER_OBSERVATION_VERSION),
    operation_id: uuidV7Schema,
    target: z
      .object({
        canonical_url: z.url({ protocol: /^https?$/ }),
        registrable_domain: z.string().min(1).max(253),
        segment: segmentSchema,
      })
      .strict(),
    representative_urls: z.array(z.url({ protocol: /^https?$/ })).max(2),
    policy: z
      .object({
        user_agent: z.string().min(1).max(300),
        methods: z.tuple([z.literal("GET"), z.literal("HEAD")]),
        use_proxy: z.literal(false),
        respect_robots: z.literal(true),
        crawl_purpose: z.literal("search"),
      })
      .strict(),
    limits: z
      .object({
        max_pages: z.number().int().min(1).max(3),
        max_requests_per_page: z.number().int().min(1).max(80),
        max_total_bytes: z
          .number()
          .int()
          .min(1)
          .max(8 * 1024 * 1024),
        page_timeout_ms: z.number().int().min(1_000).max(12_000),
        run_timeout_ms: z.number().int().min(1_000).max(45_000),
      })
      .strict(),
  })
  .strict();
export type BrowserObservationInputV1 = z.infer<
  typeof browserObservationInputV1Schema
>;

export const browserObservationOutputV1Schema = z
  .object({
    schema_version: z.literal(BROWSER_OBSERVATION_VERSION),
    operation_id: uuidV7Schema,
    actor_build: z.string().min(1).max(200),
    status: z.enum(["completed", "partial", "blocked", "failed"]),
    pages_assessed: z.number().int().min(0).max(3),
    signals: browserObservationSignalsSchema,
    observations: z
      .array(browserObservationFindingSchema)
      .length(BROWSER_OBSERVATION_IDS.length),
    timings: z
      .object({
        total_ms: z.number().int().nonnegative().max(120_000),
        pages: z.array(z.number().int().nonnegative().max(60_000)).max(3),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.observations.map((finding) => finding.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["observations"],
        message: "Duplicate browser observation IDs",
      });
    }
    const expectedIds = new Set<string>(BROWSER_OBSERVATION_IDS);
    if (
      ids.some((id) => !expectedIds.has(id)) ||
      ids.length !== expectedIds.size
    ) {
      context.addIssue({
        code: "custom",
        path: ["observations"],
        message:
          "Browser output must contain every observation ID exactly once",
      });
    }
    if (JSON.stringify(value).length > 128 * 1024) {
      context.addIssue({
        code: "custom",
        message: "Browser observation output exceeds 128 KiB",
      });
    }
  });
export type BrowserObservationOutputV1 = z.infer<
  typeof browserObservationOutputV1Schema
>;

export const browserObservationStatusResponseSchema = z
  .object({
    version: z.literal(BROWSER_OBSERVATION_VERSION),
    status: z.enum([
      "queued",
      "running",
      "completed",
      "partial",
      "blocked",
      "unavailable",
    ]),
    non_scoring: z.literal(true),
    pages_assessed: z.number().int().min(0).max(3),
    findings: z.array(browserObservationFindingSchema).max(14),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type BrowserObservationStatusResponse = z.infer<
  typeof browserObservationStatusResponseSchema
>;

export const browserObservationJobV1Schema = z
  .object({
    observation_id: uuidV7Schema,
    operation_id: uuidV7Schema,
    attempt_no: z.literal(1),
  })
  .strict();
export type BrowserObservationJobV1 = z.infer<
  typeof browserObservationJobV1Schema
>;
