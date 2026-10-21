import { z } from "zod";

export const ANALYTICS_EVENT_NAMES = [
  "landing_view",
  "scan_started",
  "scan_completed",
  "results_viewed",
  "registration_started",
  "registration_completed",
  "result_shared",
] as const;

const analyticsEventNameSchema = z.enum(ANALYTICS_EVENT_NAMES);
export type AnalyticsEventName = z.infer<typeof analyticsEventNameSchema>;

const deliveryDestinationSchema = z.enum(["posthog", "meta"]);
export type DeliveryDestination = z.infer<typeof deliveryDestinationSchema>;
