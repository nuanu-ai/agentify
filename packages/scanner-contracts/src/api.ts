import { z } from "zod";

import { checkIdSchema } from "./checks.js";
import {
  checkStatusSchema,
  diagnosticLevelSchema,
  scanStatusSchema,
  segmentSchema,
} from "./enums.js";

export const uuidV7Schema = z
  .uuid()
  .refine((value) => value[14] === "7", "Expected UUIDv7");

export const apiErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    retry_after_seconds: z.number().int().nonnegative().optional(),
    request_id: z.string().min(1),
  })
  .strict();

export const apiErrorEnvelopeSchema = z
  .object({ error: apiErrorSchema })
  .strict();
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;

export const CREATE_SCAN_REQUEST_CONTRACT_VERSION =
  "create-scan-request-v1.1.0" as const;

const EXPLICIT_URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

export function scanUrlWasSubmittedWithoutScheme(value: unknown): boolean {
  return typeof value === "string" && !EXPLICIT_URL_SCHEME.test(value.trim());
}

const submittedScanUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .transform((input, context) => {
    let parsed: URL;
    try {
      parsed = new URL(
        scanUrlWasSubmittedWithoutScheme(input) ? `https://${input}` : input,
      );
    } catch {
      context.addIssue({ code: "custom", message: "Invalid URL" });
      return z.NEVER;
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      context.addIssue({ code: "custom", message: "Expected HTTP(S) URL" });
      return z.NEVER;
    }
    if (parsed.username || parsed.password) {
      context.addIssue({
        code: "custom",
        message: "URL credentials are not allowed",
      });
      return z.NEVER;
    }
    parsed.hash = "";
    return parsed.toString();
  });

export const createScanRequestSchema = z
  .object({
    url: submittedScanUrlSchema,
    segment: segmentSchema,
    landing_variant: z.string().min(1).max(100),
    turnstile_token: z.string().min(1).max(4096).nullable(),
  })
  .strict();
export type CreateScanRequest = z.infer<typeof createScanRequestSchema>;

export const createScanResponseSchema = z
  .object({
    scan_id: uuidV7Schema,
    access_token: z.string().min(32),
    status: z.literal("accepted"),
    status_url: z.string().startsWith("/api/v1/scans/"),
    estimated_seconds: z.number().int().positive(),
  })
  .strict();
export type CreateScanResponse = z.infer<typeof createScanResponseSchema>;

const scanProgressCheckSchema = z
  .object({
    id: checkIdSchema,
    label_code: z.string().min(1),
    status: checkStatusSchema,
  })
  .strict();

export const scanStatusResponseSchema = z
  .object({
    status: scanStatusSchema,
    progress: z
      .object({ completed: z.number().int().min(0), total: z.literal(18) })
      .strict(),
    checks: z.array(scanProgressCheckSchema).max(18),
    updated_at: z.iso.datetime({ offset: true }),
    target_host: z.string().min(1).optional(),
    teaser: z
      .object({
        score: z.number().int().min(0).max(100).nullable(),
        coverage: z.number().min(0).max(1),
        level: diagnosticLevelSchema,
        top_findings: z.array(z.string().min(1)).max(3),
        positive: z.string().min(1).nullable(),
        hidden_count: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ScanStatusResponse = z.infer<typeof scanStatusResponseSchema>;

export const REGISTRATION_REQUEST_CONTRACT_VERSION =
  "registration-request-v2.0.0" as const;

export const phoneE164Schema = z
  .string()
  .trim()
  .min(8)
  .max(40)
  .transform((value) => value.replace(/[\s().-]/g, ""))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/));

export const registrationRequestSchema = z
  .object({
    email: z.email().max(320),
    phone: phoneE164Schema,
    role: z.string().trim().min(1).max(100),
    site_is_mine: z.boolean(),
    marketing_email_opt_in: z.boolean(),
    dataset_reuse_acknowledged: z.literal(true),
  })
  .strict();
export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;

export const registrationResponseSchema = z
  .object({ status: z.literal("verification_sent") })
  .strict();
export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;

export const authFinalizeRequestSchema = z
  .object({ state: z.string().min(32).max(512) })
  .strict();
export type AuthFinalizeRequest = z.infer<typeof authFinalizeRequestSchema>;

export const authFinalizeResponseSchema = z
  .object({
    status: z.literal("verified"),
    report_url: z.string().startsWith("/report/"),
  })
  .strict();
export type AuthFinalizeResponse = z.infer<typeof authFinalizeResponseSchema>;

export const contactAccessResponseSchema = z
  .object({ status: z.literal("verified") })
  .strict();

export const waitlistAnswerRequestSchema = z
  .object({ answer: z.string().trim().min(10).max(2000) })
  .strict();
export type WaitlistAnswerRequest = z.infer<typeof waitlistAnswerRequestSchema>;

const publicEvidenceValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export const reportCheckSchema = z
  .object({
    id: checkIdSchema,
    label_code: z.string().min(1),
    status: checkStatusSchema,
    summary_code: z.string().nullable(),
    user_impact_code: z.string().nullable(),
    fix_code: z.string().nullable(),
    evidence: z.record(z.string(), publicEvidenceValueSchema),
  })
  .strict();

export const reportResponseSchema = z
  .object({
    scan_id: uuidV7Schema,
    host: z.string().min(1),
    segment: segmentSchema,
    score: z.number().int().min(0).max(100).nullable(),
    coverage: z.number().min(0).max(1),
    level: diagnosticLevelSchema,
    checks: z.array(reportCheckSchema).length(18),
    waitlist: z
      .object({
        entry_id: uuidV7Schema,
        position: z.string(),
        answer: z.string().nullable(),
      })
      .strict(),
    benchmark: z
      .object({
        sample_size: z.number().int().min(30),
        average_score: z.number().min(0).max(100),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ReportResponse = z.infer<typeof reportResponseSchema>;

export const remediationPromptResponseSchema = z
  .object({
    version: z.literal("remediation-prompt-v1.0.0"),
    scope: z.enum(["teaser", "full"]),
    content: z.string().min(1).max(100_000),
    included_findings: z.array(z.string().min(1).max(200)).max(32),
    generated_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type RemediationPromptResponse = z.infer<
  typeof remediationPromptResponseSchema
>;

export const createShareRequestSchema = z
  .object({ allow_indexing: z.boolean().default(false) })
  .strict();
export const createShareResponseSchema = z
  .object({
    slug: z.string().min(32),
    public_url: z.url(),
    status: z.literal("published"),
  })
  .strict();

export const publicShareSnapshotSchema = z
  .object({
    host: z.string().min(1),
    score: z.number().int().min(0).max(100),
    level: diagnosticLevelSchema,
    rubric_version: z.string().min(1),
    generated_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PublicShareSnapshot = z.infer<typeof publicShareSnapshotSchema>;

export const sharePreviewResponseSchema = publicShareSnapshotSchema
  .extend({
    existing_share: z
      .object({
        slug: z.string().min(32),
        public_url: z.url(),
        status: z.literal("published"),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SharePreviewResponse = z.infer<typeof sharePreviewResponseSchema>;

export const accountDataRequestSchema = z
  .object({ type: z.enum(["access", "deletion"]) })
  .strict();

export const clientAnalyticsEventRequestSchema = z
  .object({
    event_id: uuidV7Schema,
    name: z.enum(["landing_view", "results_viewed", "registration_started"]),
    segment: segmentSchema.optional(),
    landing_variant: z.string().min(1).max(100).optional(),
    scan_id: uuidV7Schema.optional(),
    properties: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .default({}),
  })
  .strict();
export type ClientAnalyticsEventRequest = z.infer<
  typeof clientAnalyticsEventRequestSchema
>;
