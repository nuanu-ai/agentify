/**
 * What the browser's PostHog is started with.
 *
 * The consent banner tells a visitor that product analytics are explicit,
 * pseudonymous events in PostHog, with "No autocapture or session replay",
 * and these options are where that sentence becomes true. Every kind of
 * capture PostHog can run on its own is switched off here by name: one left
 * unset follows the PostHog project's own settings, so turning it on there
 * would start it in every consented browser with nothing changed here.
 *
 * The runtime spreads this object last into its `posthog.init` call, and the
 * test reads the same object.
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
