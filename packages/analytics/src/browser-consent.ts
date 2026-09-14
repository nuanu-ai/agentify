import type { ConsentSnapshot } from "./consent.js";

export const CONSENT_STORAGE_KEY = "b2a.consent.current.v1";

export interface ConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const readCurrentConsent = (
  storage: ConsentStorage,
): ConsentSnapshot | undefined => {
  const stored = storage.getItem(CONSENT_STORAGE_KEY);
  if (!stored) return undefined;
  try {
    const parsed = JSON.parse(stored) as ConsentSnapshot;
    if (!parsed.policyVersion || !parsed.capturedAt || !parsed.categories)
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};

export const saveConsentDecision = async (input: {
  storage: ConsentStorage;
  snapshot: ConsentSnapshot;
  persistAppendOnly: (snapshot: ConsentSnapshot) => Promise<void>;
}): Promise<void> => {
  await input.persistAppendOnly(input.snapshot);
  input.storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(input.snapshot));
};

export const loadConsentedAnalytics = async (input: {
  snapshot: ConsentSnapshot;
  loadPosthog: () => Promise<void>;
  loadMetaPixel: () => Promise<void>;
}): Promise<void> => {
  const tasks: Promise<void>[] = [];
  if (input.snapshot.categories.product_analytics)
    tasks.push(input.loadPosthog());
  if (input.snapshot.categories.ads_measurement)
    tasks.push(input.loadMetaPixel());
  await Promise.all(tasks);
};
