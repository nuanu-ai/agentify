/**
 * What the browser's PostHog is started with.
 *
 * The consent banner tells a visitor that product analytics are explicit,
 * pseudonymous events in PostHog, with "No autocapture or session replay",
 * and these options are where that sentence becomes true.
 *
 * The runtime spreads this object last into its `posthog.init` call, and the
 * test reads the same object.
 */
export const POSTHOG_BROWSER_OPTIONS = {
  autocapture: false,
  disable_session_recording: true,
  capture_pageview: false,
  capture_pageleave: false,
  person_profiles: "never",
} as const;
