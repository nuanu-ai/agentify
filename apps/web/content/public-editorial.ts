import {
  CHECK_DEFINITIONS,
  SCAN_RUBRIC_VERSION,
} from "@agentify/scanner-contracts";

import type { PublicAppConfig } from "../lib/app-config";

export type PublicEditorialPath =
  "/methodology" | "/scanner" | "/privacy" | "/terms";

export type InlineNode = Readonly<{
  kind: "text" | "code" | "strong" | "link";
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
const code = (value: string): InlineNode => ({ kind: "code", value });
const strong = (value: string): InlineNode => ({ kind: "strong", value });
const link = (value: string, href: string): InlineNode => ({
  kind: "link",
  value,
  href,
});

const methodologyPage = (): PublicEditorialPageModel => ({
  path: "/methodology",
  eyebrow: `Methodology · rubric ${SCAN_RUBRIC_VERSION}`,
  title: "How the agent-readiness scan works",
  intro:
    "We diagnose public, machine-readable website signals. The result is a versioned technical baseline — never a certification, search ranking, or promise of model behavior.",
  sections: [
    {
      id: "what",
      title: "What we check",
      blocks: [
        {
          kind: "paragraph",
          content: `The rubric contains exactly ${CHECK_DEFINITIONS.length} canonical checks across discovery, structured content, agent-like HTTP access, segment signals, and informational experimental surfaces.`,
        },
        {
          kind: "list",
          items: CHECK_DEFINITIONS.map((check) => [
            code(`#${check.id}`),
            text(
              ` ${check.labelCode.replaceAll("_", " ")} — nominal weight ${check.nominalWeight}`,
            ),
          ]),
        },
      ],
    },
    {
      id: "scoring",
      title: "How scoring works",
      blocks: [
        {
          kind: "paragraph",
          content:
            "The backend excludes not-applicable checks, removes unavailable weight from the assessed denominator, and stores the resulting score together with coverage and rubric version. The browser never recomputes these values.",
        },
        {
          kind: "notice",
          content:
            "Coverage below 70% produces an incomplete, provisional result. Coverage below 30% produces no public score. Benchmarks stay hidden until the documented sample gate is reached.",
        },
        {
          kind: "list",
          items: [
            "Invisible: 0–24",
            "Readable: 25–49",
            "Callable-ready: 50–69",
            "Ahead of the market: 70–100",
          ],
        },
      ],
    },
    {
      id: "states",
      title: "The five result states",
      blocks: [
        {
          kind: "list",
          items: [
            "Pass — the expected public signal was verified.",
            "Partial — a signal is present but incomplete.",
            "Fail — an accessible surface confirmed a negative fact.",
            "Unavailable — we could not reach a verdict; this is not a failure.",
            "Not applicable — the check does not apply to this site or segment.",
          ],
        },
      ],
    },
    {
      id: "browser-observation",
      title: "Non-scoring browser observations",
      blocks: [
        {
          kind: "paragraph",
          content: [
            text("When enabled, the separate "),
            code("browser-public-v1.0.0"),
            text(
              " layer passively renders public pages to observe JavaScript-only content, accessibility/form semantics, runtime/network health, metadata consistency, declared agent/API surfaces, and rendering cost. These findings are shown separately and never change the 18-check ",
            ),
            code(SCAN_RUBRIC_VERSION),
            text(" score."),
          ],
        },
      ],
    },
    {
      id: "limits",
      title: "Limitations",
      blocks: [
        {
          kind: "paragraph",
          content:
            "A regional HTTP measurement can observe latency, output, metadata, and access at scan time. It does not prove worldwide availability, crawler identity enforcement, live stock or appointment correctness, or how any particular model will answer.",
        },
        {
          kind: "notice",
          content:
            "“Callable-ready” describes public discovery metadata. It does not mean that Agentify invoked a tool, authenticated a user, completed a booking, or verified checkout.",
        },
      ],
    },
    {
      id: "coverage-boundary",
      title: "Checked, observed, and owner-only",
      blocks: [
        {
          kind: "list",
          items: [
            [
              strong("Checked:"),
              text(
                " public crawler policy, sitemap, substantive initial HTML, JSON-LD structure, and the optional llms.txt surface.",
              ),
            ],
            [
              strong("Observed only:"),
              text(
                " public protocol declarations, passive browser structure, form semantics, and a bounded sample of visible-versus-structured facts.",
              ),
            ],
            [
              strong("Requires verified ownership:"),
              text(
                " authentication, tool calls, forms, booking, checkout, payments, rate-limit testing, idempotency, receipts, internal logs, SLOs, and kill switches.",
              ),
            ],
          ],
        },
      ],
    },
    {
      id: "not-do",
      title: "What we do not do",
      blocks: [
        {
          kind: "paragraph",
          content:
            "We do not log in, submit forms, click actions, bypass robots or access controls, scan non-standard ports, perform vulnerability probing, make bookings, execute checkout, or change the target site. The optional passive browser layer executes only the public page JavaScript needed to render it and blocks mutating requests.",
        },
      ],
    },
  ],
});

const scannerPage = (config: PublicAppConfig): PublicEditorialPageModel => ({
  path: "/scanner",
  eyebrow: "Scanner identity · public HTTP and passive browser observation",
  title: "About agentify-scanner",
  intro:
    "This page identifies the scanner honestly and describes the outbound behavior target-site operators can expect.",
  sections: [
    {
      id: "identity",
      title: "Identity and contact",
      blocks: [
        {
          kind: "paragraph",
          content: [
            text("Scanner user agent: "),
            code(config.scannerUserAgent),
          ],
        },
        {
          kind: "paragraph",
          content: [
            text(
              `Operator: ${config.legalOperator}. Abuse and opt-out contact: `,
            ),
            link(config.abuseEmail, `mailto:${config.abuseEmail}`),
            text("."),
          ],
        },
        ...(config.legalIdentityConfirmed
          ? []
          : [
              {
                kind: "notice" as const,
                content:
                  "The production domain is active, but final legal identity remains a paid-launch blocker.",
              },
            ]),
      ],
    },
    {
      id: "behavior",
      title: "Canonical HTTP scanner behavior",
      blocks: [
        {
          kind: "list",
          items: [
            "GET and HEAD only; no JavaScript, cookies, credentials, forms, or browser session.",
            "Public HTTP(S) on ports 80 and 443 only.",
            "At most 5 redirects, revalidated at every hop.",
            "At most 18 outbound requests per scan and 2 concurrent requests per origin.",
            "Individual fetch timeout at 8 seconds; global result target within 60 seconds.",
          ],
        },
      ],
    },
    {
      id: "browser-observation",
      title: "Optional passive browser observation",
      blocks: [
        {
          kind: "paragraph",
          content: [
            text(
              "A separate non-scoring layer may render up to three public same-site pages through a private Apify Actor. Its user agent is ",
            ),
            code(
              `agentify-browser-observer/1.0 (+${new URL("/scanner", config.baseUrl).toString()})`,
            ),
            text(
              ". Provider, budget, or challenge failures never reduce the canonical score.",
            ),
          ],
        },
        {
          kind: "list",
          items: [
            "GET and HEAD only; public ports 80 and 443 only.",
            "No clicks, form entry/submission, login, checkout, CAPTCHA solving, proxy rotation, or access-control bypass.",
            "Fresh browser context for every run; downloads, popups, permissions, service workers, WebSockets, and mutating requests are blocked.",
            "We retain sanitized aggregate signals and finding codes, not raw HTML, screenshots, cookies, storage state, console text, full accessibility trees, or provider run IDs.",
          ],
        },
      ],
    },
    {
      id: "robots",
      title: "Robots behavior",
      blocks: [
        {
          kind: "paragraph",
          content: [
            text("We fetch "),
            code("/robots.txt"),
            text(
              " first. If the scanner or wildcard group disallows the submitted path, content checks are marked unavailable. We do not bypass that rule.",
            ),
          ],
        },
      ],
    },
    {
      id: "limits",
      title: "Body and safety limits",
      blocks: [
        {
          kind: "paragraph",
          content:
            "Decoded HTML is capped at 2 MiB, robots at 512 KiB, discovery JSON at 1 MiB, and sitemap data at 5 MiB. Every DNS result and redirect destination must be public global unicast; private, local, reserved, metadata, credentialed, and secret-bearing URLs are rejected.",
        },
      ],
    },
    {
      id: "retention",
      title: "Cache and retention",
      blocks: [
        {
          kind: "paragraph",
          content:
            "Eligible technical snapshots may be cached for 24 hours. We do not retain target raw bodies, cookies, full headers, credentials, or raw IP addresses. Structured scan facts follow the retention described in the privacy page.",
        },
      ],
    },
    {
      id: "opt-out",
      title: "Opt out or report a problem",
      blocks: [
        {
          kind: "paragraph",
          content: [
            text(
              "Send the affected host, approximate UTC time, and request identifier if available to ",
            ),
            link(config.abuseEmail, `mailto:${config.abuseEmail}`),
            text(
              ". Do not email access tokens, private URLs, credentials, or personal data.",
            ),
          ],
        },
      ],
    },
  ],
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
            "Consent snapshots and allowlisted acquisition fields when the relevant implementation is enabled.",
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
            "Essential processing is used to perform the requested scan, prevent abuse, and keep the private result available. Product analytics, ads measurement, dataset reuse, marketing email, and card signal are independent choices. Declining an optional category does not turn it into essential processing.",
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
            "The architecture supports private Postgres storage and in-process Better Auth with Resend for passwordless confirmation, PostHog for explicit product analytics, Meta Pixel/CAPI for consented ads measurement, Cloudflare Turnstile for abuse challenges, and Stripe for an optional $0 card signal. Apify acts as the isolated processor for optional passive public-page rendering; the API token is worker-only, the Actor is private and build-pinned, and output storage is deleted after validated ingestion. Provider adapters and destinations are disabled until configured; local success is not evidence of production delivery.",
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
              " for access, correction, unsubscribe, or verified deletion. Deletion first detaches or cancels the optional card signal and verifies provider state; only then are report sessions and shares revoked and lead, waitlist, analytics-delivery, and owned-scan identifiers removed or irreversibly anonymized. Deidentified score, coverage, check status, and coarse technical metrics may remain under the stated scan-dataset retention, but the original URL, host, access capability, share snapshot, and session join are removed from the retained scan record.",
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
    case "/methodology":
      return methodologyPage();
    case "/scanner":
      return scannerPage(config);
    case "/privacy":
      return privacyPage(config);
    case "/terms":
      return termsPage(config);
  }
}
