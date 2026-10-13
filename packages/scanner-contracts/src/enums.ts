import { z } from "zod";
import { CHECK_STATUSES, DIAGNOSTIC_LEVELS, SCAN_STATUSES, SEGMENTS } from "./browser.js";

export const segmentSchema = z.enum(SEGMENTS);
export type Segment = z.infer<typeof segmentSchema>;

export const scanStatusSchema = z.enum(SCAN_STATUSES);

export const checkStatusSchema = z.enum(CHECK_STATUSES);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const diagnosticLevelSchema = z.enum(DIAGNOSTIC_LEVELS);
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
