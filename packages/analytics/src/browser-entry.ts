export * from "./browser-consent.js";
export { POSTHOG_BROWSER_OPTIONS } from "./browser-posthog.js";
export {
  CONSENT_POLICY_VERSION,
  type ConsentCategories,
  type ConsentPolicy,
  type ConsentSnapshot,
  consentAllowsDestination,
  createConsentSnapshot,
  DEFAULT_CONSENT,
} from "./consent.js";
