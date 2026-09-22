import { z } from "zod";

export const SCAN_RUBRIC_VERSION = "gtm-v1.0.0" as const;

export const CHECK_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const checkIdSchema = z
  .number()
  .int()
  .min(1)
  .max(18)
  .transform((value) => value as CheckId);

export const CHECK_DEFINITIONS = [
  { id: 1, labelCode: "robots", nominalWeight: 5 },
  { id: 2, labelCode: "ai_policy", nominalWeight: 8 },
  { id: 3, labelCode: "content_signal", nominalWeight: 4 },
  { id: 4, labelCode: "sitemap", nominalWeight: 6 },
  { id: 5, labelCode: "json_ld_presence", nominalWeight: 10 },
  { id: 6, labelCode: "vertical_json_ld", nominalWeight: 12 },
  { id: 7, labelCode: "markdown_negotiation", nominalWeight: 8 },
  { id: 8, labelCode: "llms_txt", nominalWeight: 2 },
  { id: 9, labelCode: "mcp_server_card", nominalWeight: 6 },
  { id: 10, labelCode: "ucp_profile", nominalWeight: 6 },
  { id: 11, labelCode: "oauth_discovery", nominalWeight: 4 },
  { id: 12, labelCode: "raw_html_ssr", nominalWeight: 10 },
  { id: 13, labelCode: "agent_ua_accessibility", nominalWeight: 8 },
  { id: 14, labelCode: "page_weight_latency", nominalWeight: 4 },
  { id: 15, labelCode: "store_feed_signals", nominalWeight: 4 },
  { id: 16, labelCode: "platform_fingerprint", nominalWeight: 0 },
  { id: 17, labelCode: "a2a_agent_card", nominalWeight: 1 },
  { id: 18, labelCode: "hreflang_locales", nominalWeight: 2 },
] as const satisfies ReadonlyArray<{
  id: CheckId;
  labelCode: string;
  nominalWeight: number;
}>;

const evidenceValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const checkResultSchema = z
  .object({
    id: checkIdSchema,
    status: z.enum(["pass", "partial", "fail", "unavailable", "not_applicable"]),
    nominalWeight: z.number().nonnegative(),
    applicableWeight: z.number().nonnegative(),
    earnedWeight: z.number().nonnegative(),
    summaryCode: z.string().min(1),
    evidence: z.record(z.string(), evidenceValueSchema),
    userImpactCode: z.string().min(1),
    fixCode: z.string().min(1).optional(),
    durationMs: z.number().int().nonnegative(),
    errorCode: z.string().min(1).optional(),
  })
  .strict();
export type CheckResult = z.infer<typeof checkResultSchema>;
