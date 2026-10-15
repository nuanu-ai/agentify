import type { PublicAppConfig } from "../lib/app-config";

export type PublicEditorialPath = "/privacy" | "/terms";

type InlineNode = Readonly<{
  kind: "text" | "link";
  value: string;
  href?: string;
}>;

export type RichText = string | readonly InlineNode[];

export type EditorialBlock =
  | Readonly<{ kind: "paragraph" | "notice"; content: RichText }>
  | Readonly<{ kind: "list"; items: readonly RichText[] }>;

export type PublicEditorialPageModel = Readonly<{
  path: PublicEditorialPath;
  eyebrow: string;
  title: string;
  intro: string;
  sections: readonly Readonly<{
    id: string;
    title: string;
    blocks: readonly EditorialBlock[];
  }>[];
}>;

const text = (value: string): InlineNode => ({ kind: "text", value });
const link = (value: string, href: string): InlineNode => ({
  kind: "link",
  value,
  href,
});

const privacyPage = (config: PublicAppConfig): PublicEditorialPageModel => ({
  path: "/privacy",
  eyebrow: "Privacy · deployment policy",
  title: "Privacy and data controls",
  intro:
    "We minimize personal data, keep scan capabilities private by default, and separate essential processing from optional analytics, dataset reuse, marketing, and card signals.",
  sections: [
    {
      id: "controller",
      title: "Operator and contact",
      blocks: [
        {
          kind: "paragraph",
          content: [
            text(`Operator: ${config.legalOperator}. Privacy contact: `),
            link(config.privacyEmail, `mailto:${config.privacyEmail}`),
            text("."),
          ],
        },
        ...(config.legalIdentityConfirmed
          ? []
          : [
              {
                kind: "notice" as const,
                content:
                  "Final legal identity, jurisdiction-specific lawful basis, and processor terms are not yet confirmed. This deployment must not receive paid traffic until they are approved.",
              },
            ]),
      ],
    },
    {
      id: "data",
      title: "Data we process",
      blocks: [
        {
          kind: "list",
          items: [
            "Submitted and canonical target URL, target host/hash, segment, and scan status.",
            "Structured check outcomes, score, coverage, rubric version, and coarse fingerprint signals.",
            "When passive browser observation is enabled: sanitized finding codes and aggregate counts/timings. Raw page content, screenshots, cookies, console messages, accessibility trees, and provider run IDs are not retained in reports.",
            "Hashed network rate keys; raw IP addresses are not stored.",
            "Email, international phone, role, and registration choices only when the contact form is submitted. Email and phone are encrypted with separate lookup HMAC domains; phone is contact data and is not treated as verified.",
            "Signing in creates an account and session record. Google sign-in also retains Google's issuer and stable account identifier, linked to your account email. Google profile names and pictures are not retained, and Google access, refresh and ID tokens are not stored in our database or cookies.",
            "Your privacy choices. Visit and funnel events, such as a page view, a scan or a registration, and the campaign tags of the link you arrived by, only if you allow product analytics or ads measurement.",
          ],
        },
      ],
    },
    {
      id: "purpose",
      title: "Purpose and choices",
      blocks: [
        {
          kind: "paragraph",
          content:
            "Essential processing is used to perform the requested scan, prevent abuse, and keep the private result available. Product analytics, ads measurement, dataset reuse, marketing email, and card signal are independent choices. Declining an optional category does not turn it into essential processing. If you allow neither product analytics nor ads measurement, no visit or funnel events and no campaign tags are recorded for you.",
        },
      ],
    },
    {
      id: "sharing",
      title: "Private and public results",
      blocks: [
        {
          kind: "paragraph",
          content:
            "Progress and teaser require the scan capability. A full report requires verified authorization. A public share does not exist until explicit publish, and its immutable snapshot contains only domain, score, level, scale, and date. It can be revoked.",
        },
      ],
    },
    {
      id: "processors",
      title: "Processors and optional services",
      blocks: [
        {
          kind: "paragraph",
          content:
            "The architecture supports private Postgres storage and in-process Better Auth with Resend for passwordless confirmation, optional Google sign-in, PostHog for explicit product analytics, Meta Pixel/CAPI for consented ads measurement, Cloudflare Turnstile for abuse challenges, and Stripe for an optional $0 card signal. Choosing Google takes your browser to Google to authenticate; we do not request access to your mailbox, Drive or other Google services. Apify acts as the isolated processor for optional passive public-page rendering; the API token is worker-only, the Actor is private and build-pinned, and output storage is deleted after validated ingestion. Provider adapters and destinations are disabled until configured; local success is not evidence of production delivery.",
        },
      ],
    },
    {
      id: "retention",
      title: "Retention",
      blocks: [
        {
          kind: "list",
          items: [
            "Operational logs: 14 days, without email, raw IP, secrets, or full URL query.",
            "Expired or used registration intents and legacy verification tokens: the executable retention cleanup removes them after 7 days.",
            "Unverified email: the same idempotent cleanup irreversibly anonymizes it after 30 days by default.",
            "Raw analytics events: 13 months.",
            "Structured scan/check/fingerprint dataset: 24 months, then review or anonymization.",
          ],
        },
      ],
    },
    {
      id: "rights",
      title: "Access, deletion, and correction",
      blocks: [
        {
          kind: "paragraph",
          content: [
            text("Use the "),
            link("data-request route", "/data-request"),
            text(
              " for access, correction, unsubscribe, or verified deletion. Deletion first detaches or cancels the optional card signal and verifies provider state; only then is report access closed, shares revoked, and lead, waitlist, analytics-delivery, and owned-scan identifiers removed or irreversibly anonymized. The sign-in for your address is removed with them unless it holds a seller dashboard. Deidentified score, coverage, check status, and coarse technical metrics may remain under the stated scan-dataset retention, but the original URL, host, access capability, share snapshot, and session join are removed from the retained scan record.",
            ),
          ],
        },
      ],
    },
  ],
});

const termsPage = (config: PublicAppConfig): PublicEditorialPageModel => ({
  path: "/terms",
  eyebrow: "Terms · diagnostic service",
  title: "Terms of use",
  intro: `Use ${config.displayBrand} only for lawful inspection of public websites. A diagnostic result is evidence from a bounded HTTP scan, not a certification or outcome guarantee.`,
  sections: [
    {
      id: "service",
      title: "Service scope",
      blocks: [
        {
          kind: "paragraph",
          content:
            "The service reads public HTTP surfaces and returns a versioned diagnostic. It does not provide legal, security, SEO, payment, booking, or model-output assurance.",
        },
      ],
    },
    {
      id: "use",
      title: "Acceptable use",
      blocks: [
        {
          kind: "list",
          items: [
            "Do not submit private, credentialed, secret-bearing, or access-controlled URLs.",
            "Do not use the service to probe vulnerabilities, evade controls, harass an operator, or overload a target.",
            "Do not misrepresent the diagnostic as certification, endorsement, ranking, or verified ownership.",
            "You may scan a competitor's public site; an ownership checkbox is a claim, not domain verification.",
          ],
        },
      ],
    },
    {
      id: "availability",
      title: "Availability and limits",
      blocks: [
        {
          kind: "paragraph",
          content:
            "Rate limits, abuse controls, maintenance, target restrictions, and scanner capacity may delay or reject a request. A failed or incomplete scan produces no promised report.",
        },
      ],
    },
    {
      id: "liability",
      title: "No outcome promise",
      blocks: [
        {
          kind: "paragraph",
          content:
            "Results reflect public signals observed at scan time and may change. Do not rely on a score as proof of model inclusion, traffic, revenue, live inventory, successful checkout, available appointments, or security.",
        },
      ],
    },
    {
      id: "contact",
      title: "Contact",
      blocks: [
        {
          kind: "paragraph",
          content: [
            text("Report abuse or terms concerns to "),
            link(config.abuseEmail, `mailto:${config.abuseEmail}`),
            text("."),
          ],
        },
      ],
    },
  ],
});

export function getPublicEditorialPage(
  path: PublicEditorialPath,
  config: PublicAppConfig,
): PublicEditorialPageModel {
  switch (path) {
    case "/privacy":
      return privacyPage(config);
    case "/terms":
      return termsPage(config);
  }
}
