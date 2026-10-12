/**
 * What the browser's PostHog is started with. The consent banner promises no
 * autocapture or session replay, so every kind of capture PostHog can run on
 * its own is switched off here by name: one left unset follows the PostHog
 * project's settings, and turning it on there would start it in every
 * consented browser. The runtime spreads this object last into `posthog.init`.
 */
export const POSTHOG_BROWSER_OPTIONS = {
  autocapture: false,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  capture_exceptions: false,
  capture_performance: false,
  disable_session_recording: true,
  capture_pageview: false,
  capture_pageleave: false,
  person_profiles: "never",
} as const;
