/**
 * What every surface tells a crawler and a link's card about the site as a
 * whole: the picture a link unfurls into and the description of the site and
 * its operator. Each is built from the site's address as the surface knows
 * it, the scanner from its settings and the documentation from the template
 * Caddy fills, so the address is joined as text rather than parsed.
 */

/** The card a link to any page of the site unfurls into, which the scanner draws at `path`. */
export const SITE_PICTURE = {
  path: "/opengraph-image",
  type: "image/png",
  width: 1200,
  height: 630,
  alt: "Agentify website agent-readiness diagnostic",
} as const;

/** The page that names the scanner and how to reach its operator. */
const IDENTITY_PAGE = "/docs/scanner";

/** The diagnostic and merchant services described across the site's public pages. */
const SITE_DESCRIPTION =
  "Agentify checks public, machine-readable website signals and lets merchants publish products and services, receive purchases from AI agents, and fulfill orders through its SDK.";

/** The site and its operator as schema.org describes them; `origin` has no trailing slash. */
export function siteSchema({
  brand,
  origin,
  abuseEmail,
}: Readonly<{ brand: string; origin: string; abuseEmail: string }>): object {
  const organizationId = `${origin}/#organization`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: brand,
        url: `${origin}/`,
        logo: `${origin}/icon.svg`,
        description: SITE_DESCRIPTION,
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "abuse reports",
          email: abuseEmail,
          url: `${origin}${IDENTITY_PAGE}`,
        },
      },
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name: brand,
        url: `${origin}/`,
        publisher: { "@id": organizationId },
      },
    ],
  };
}
