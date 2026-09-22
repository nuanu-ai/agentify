import { DISPLAY_BRAND } from "./brand";

const DEFAULT_BASE_URL = "http://localhost:3000";

export type PublicAppConfig = Readonly<{
  displayBrand: string;
  baseUrl: string;
  scannerUserAgent: string;
  privacyEmail: string;
  abuseEmail: string;
  legalOperator: string;
  legalIdentityConfirmed: boolean;
}>;

export function getPublicAppConfig(): PublicAppConfig {
  const baseUrl = process.env.APP_BASE_URL || DEFAULT_BASE_URL;

  return {
    displayBrand: DISPLAY_BRAND,
    baseUrl,
    scannerUserAgent: `agentify-scanner/1.0 (+${baseUrl}/scanner)`,
    privacyEmail: process.env.PRIVACY_EMAIL || "privacy@agentify.ad",
    abuseEmail: process.env.ABUSE_EMAIL || "abuse@agentify.ad",
    legalOperator: process.env.LEGAL_OPERATOR || "Operator identity pending confirmation",
    legalIdentityConfirmed: process.env.LEGAL_IDENTITY_CONFIRMED === "true",
  };
}
