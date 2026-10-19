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
            "Your privacy choices. Visit and funnel events, such as a page view, a scan or a registration, and the campaign tags of the link you arrived by, only if you allow product analytics or ads measurement. One report does not depend on these choices: telling the ad tracker that a click on one of our ads led to a registration, which the next item and the section on processors describe.",
            "If you arrive at sign-in from one of our ads, the identifier the ad tracker gave that click: with the sign-in link you then ask for, or with the Google sign-in you then start, and, if that is the first time you sign in with your address, with your account until the report to the ad tracker has been made or given up.",
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
            "Essential processing is used to perform the requested scan, prevent abuse, and keep the private result available. Product analytics, ads measurement, dataset reuse, marketing email, and card signal are independent choices. Declining an optional category does not turn it into essential processing. If you allow neither product analytics nor ads measurement, no visit or funnel events and no campaign tags are recorded for you; the one report to the ad tracker of a registration from our ad, described under processors, is apart from these choices.",
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
            "The architecture supports private Postgres storage and in-process Better Auth with Resend for passwordless confirmation, optional Google sign-in, PostHog for explicit product analytics, Meta Pixel/CAPI for consented ads measurement, Cloudflare Turnstile for abuse challenges, and Stripe for an optional $0 card signal. Choosing Google takes your browser to Google to authenticate; we do not request access to your mailbox, Drive or other Google services. When you arrive at sign-in from one of our ads, AI Samurai, the ad tracker our ads run through, is told that this click led to a registration, by the click's identifier alone. Nothing else about you leaves: not your email address, nor anything else about your account. This happens by default, without anything to tick on the sign-in page, and only once: when the sign-in you start from the ad is the first time you sign in with your address, whether by an emailed link or with Google. The identifier is then erased, as the retention section says. Apify acts as the isolated processor for optional passive public-page rendering; the API token is worker-only, the Actor is private and build-pinned, and output storage is deleted after validated ingestion. Provider adapters and destinations are disabled until configured; local success is not evidence of production delivery.",
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
            "Ad click identifier from sign-up: kept with the sign-in link, which works for an hour, until the link is used, or, if it never is, cleared from 7 days after the link expired; kept with a Google sign-in, which may take ten minutes, until your return from Google uses it up, or, if that never happens, cleared from 7 days after those ten minutes. If that is the first time you sign in with your address, it is kept with your account until the tracker accepts or refuses the report or a day of attempts has passed, and is then erased; what stays with your account, until the account is deleted, is a record of whether the report went through and when. Otherwise nothing about the click is kept once you sign in.",
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
