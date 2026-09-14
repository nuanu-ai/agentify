import { z } from "zod";

export const segmentSchema = z.enum(["store", "owner", "local"]);
export type Segment = z.infer<typeof segmentSchema>;

export const scanStatusSchema = z.enum([
  "accepted",
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
]);
export type ScanStatus = z.infer<typeof scanStatusSchema>;

export const checkStatusSchema = z.enum([
  "pending",
  "running",
  "pass",
  "partial",
  "fail",
  "unavailable",
  "not_applicable",
]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const diagnosticLevelSchema = z.enum([
  "invisible",
  "readable",
  "callable_ready",
  "ahead_of_market",
  "incomplete",
]);
export type DiagnosticLevel = z.infer<typeof diagnosticLevelSchema>;

export const consentCategorySchema = z.enum([
  "essential_processing",
  "product_analytics",
  "ads_measurement",
  "marketing_email",
  "dataset_reuse",
  "card_signal",
]);
export type ConsentCategory = z.infer<typeof consentCategorySchema>;
