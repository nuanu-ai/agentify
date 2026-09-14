import type { ConsentCategory } from "@b2a/contracts";

export const CONSENT_POLICY_VERSION = "consent-v1.0.0" as const;

export type ConsentCategories = Record<ConsentCategory, boolean>;
export type ConsentEnvironment = "local" | "test" | "preview" | "production";

export type ConsentSnapshot = {
  policyVersion: string;
  country?: string;
  categories: ConsentCategories;
  capturedAt: string;
  source: "banner" | "registration" | "card" | "api";
};

export type ConsentPolicy = {
  policyVersion: string;
  requireOptInForProductAnalytics: boolean;
  requireOptInForAdsMeasurement: boolean;
};

export const DEFAULT_CONSENT: ConsentCategories = {
  essential_processing: true,
  product_analytics: false,
  ads_measurement: false,
  marketing_email: false,
  dataset_reuse: false,
  card_signal: false,
};

export const createConsentSnapshot = (input: {
  policy: ConsentPolicy;
  decisions: Partial<ConsentCategories>;
  country?: string;
  source: ConsentSnapshot["source"];
  capturedAt?: Date;
}): ConsentSnapshot => {
  if (input.decisions.essential_processing === false) {
    throw new Error("essential_processing_required");
  }
  const categories = {
    ...DEFAULT_CONSENT,
    ...input.decisions,
    essential_processing: true,
  };
  return {
    policyVersion: input.policy.policyVersion,
    ...(input.country
      ? { country: input.country.toUpperCase().slice(0, 2) }
      : {}),
    categories,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    source: input.source,
  };
};

export const consentAllowsDestination = (
  snapshot: ConsentSnapshot,
  destination: "posthog" | "meta",
): boolean =>
  destination === "posthog"
    ? snapshot.categories.product_analytics
    : snapshot.categories.ads_measurement;

export const assertDestinationIsolation = (
  runtime: ConsentEnvironment,
  destination: ConsentEnvironment,
): void => {
  if (runtime !== destination)
    throw new Error("analytics_environment_mismatch");
};
