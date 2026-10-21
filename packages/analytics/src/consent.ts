import type { ConsentCategory } from "@agentify/scanner-contracts";

export const CONSENT_POLICY_VERSION = "consent-v1.0.0" as const;

export type ConsentCategories = Record<ConsentCategory, boolean>;
export type ConsentEnvironment = "local" | "test" | "preview" | "production";

export type ConsentSnapshot = {
  policyVersion: string;
  categories: ConsentCategories;
  capturedAt: string;
  source: "banner" | "registration" | "api";
};

export const DEFAULT_CONSENT: ConsentCategories = {
  essential_processing: true,
  product_analytics: false,
  ads_measurement: false,
  marketing_email: false,
  dataset_reuse: false,
};

/**
 * What a stored snapshot records, by the categories the policy names. A stored
 * key the policy does not name, or a value that is not a yes or a no, is passed
 * over, so a snapshot copied forward carries no category the policy lacks.
 */
export const storedConsentCategories = (stored: unknown): Partial<ConsentCategories> => {
  if (!stored || typeof stored !== "object") return {};
  const recorded = stored as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(DEFAULT_CONSENT).flatMap((category) =>
      typeof recorded[category] === "boolean" ? [[category, recorded[category]]] : [],
    ),
  );
};

export const createConsentSnapshot = (input: {
  policyVersion: string;
  decisions: Partial<ConsentCategories>;
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
    policyVersion: input.policyVersion,
    categories,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    source: input.source,
  };
};

/**
 * Whether anything of a visit may be recorded: its visit and funnel events and
 * the campaign that brought it. Product analytics and ads measurement are the
 * two optional measurements a visitor can allow; with neither allowed, the
 * visit leaves nothing behind but the choice itself and what the scan the
 * visitor asked for needs.
 */
export const consentAllowsMeasurement = (categories: Partial<ConsentCategories>): boolean =>
  categories.product_analytics === true || categories.ads_measurement === true;

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
  if (runtime !== destination) throw new Error("analytics_environment_mismatch");
};
