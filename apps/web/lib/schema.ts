import { getPublicAppConfig } from "./app-config";

// What a crawler reads as the site's description. It says what the
// /methodology intro says to a person (content/public-editorial.ts); the
// footer used to repeat it and no longer does.
const SITE_DESCRIPTION =
  "A diagnostic for public, machine-readable website signals. We do not modify sites or test a particular model's answer.";

export function publicSiteSchema(): object {
  const config = getPublicAppConfig();
  const baseUrl = new URL(config.baseUrl).toString();
  const organizationId = new URL("/#organization", baseUrl).toString();
  const websiteId = new URL("/#website", baseUrl).toString();

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: config.displayBrand,
        url: baseUrl,
        logo: new URL("/icon.svg", baseUrl).toString(),
        description: SITE_DESCRIPTION,
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "abuse reports",
          email: config.abuseEmail,
          url: new URL("/scanner", baseUrl).toString(),
        },
      },
      {
        "@type": "WebSite",
        "@id": websiteId,
        name: config.displayBrand,
        url: baseUrl,
        publisher: { "@id": organizationId },
      },
    ],
  };
}
