import { z } from "zod";
import { PARTNER_CLICK_ID_PATTERN } from "./browser.js";

export { PARTNER_CLICK_ID_ALIASES } from "./browser.js";

export const ANALYTICS_EVENT_NAMES = [
  "landing_view",
  "scan_started",
  "scan_completed",
  "results_viewed",
  "registration_started",
  "registration_completed",
  "card_attached",
  "result_shared",
] as const;

export const analyticsEventNameSchema = z.enum(ANALYTICS_EVENT_NAMES);
export type AnalyticsEventName = z.infer<typeof analyticsEventNameSchema>;

export const deliveryDestinationSchema = z.enum(["posthog", "meta", "partner_tracker"]);
export type DeliveryDestination = z.infer<typeof deliveryDestinationSchema>;

export const partnerClickIdSchema = z.string().regex(PARTNER_CLICK_ID_PATTERN);
