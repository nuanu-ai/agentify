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
  const baseUrl = process.env.NEXT_PUBLIC_APP_BASE_URL || DEFAULT_BASE_URL;

  return {
    displayBrand: process.env.NEXT_PUBLIC_DISPLAY_BRAND || "Agentify",
    baseUrl,
    scannerUserAgent: `agentify-scanner/1.0 (+${baseUrl}/scanner)`,
    privacyEmail:
      process.env.NEXT_PUBLIC_PRIVACY_EMAIL || "privacy@agentify.ad",
    abuseEmail: process.env.NEXT_PUBLIC_ABUSE_EMAIL || "abuse@agentify.ad",
    legalOperator:
      process.env.NEXT_PUBLIC_LEGAL_OPERATOR ||
      "Operator identity pending confirmation",
    legalIdentityConfirmed:
      process.env.NEXT_PUBLIC_LEGAL_IDENTITY_CONFIRMED === "true",
  };
}
