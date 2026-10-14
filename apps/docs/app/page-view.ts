/**
 * A page of the documentation seen, sent where the visitor allowed measuring
 * and where the deployment names a destination for the environment it runs
 * in: to PostHog as a page view when product analytics is allowed, to the
 * Meta pixel as one when ads measurement is. Fetched with the services it
 * starts only once a visitor allowed one of them, so a visit nobody measures
 * never loads it.
 */

import type { ConsentSnapshot } from "@agentify/analytics/browser";
import { type BrowserAnalyticsConfig, metaPixelOf, posthogOf } from "@agentify/consent";

export async function sendPageView(
  config: BrowserAnalyticsConfig,
  consent: ConsentSnapshot,
  address: string,
): Promise<void> {
  if (consent.categories.ads_measurement) metaPixelOf(config)?.("track", "PageView");
  if (!consent.categories.product_analytics) return;
  const posthog = await posthogOf(config);
  posthog?.capture(
    "$pageview",
    { $current_url: address, $process_person_profile: false },
    { send_instantly: true },
  );
}
