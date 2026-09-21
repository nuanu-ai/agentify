import type { Segment } from "@agentify/scanner-contracts";

import type { SourceId } from "./sources";

export type LandingConfig = Readonly<{
  segment: Segment;
  variant: string;
  locale: "en-US" | "ru-RU";
  eyebrow: string;
  hero: Readonly<{ title: string; subtitle: string; cta: string }>;
  /**
   * One line under the scan form for the person who came to sell rather than
   * to scan: a lead-in and a link to the page about selling to agents. Only
   * the front page carries it; the segment pages leave it out.
   */
  secondDoor?: Readonly<{ lead: string; label: string; href: string }>;
  pains: readonly Readonly<{
    title: string;
    body: string;
    sourceIds: readonly [SourceId, ...SourceId[]];
  }>[];
  faq: readonly Readonly<{ question: string; answer: string }>[];
  reportPreviewFixture: "canonical-example-v1";
  segmentPhase: string;
}>;

export const LANDING_SHARED_CONTENT = {
  assurances: [
    "Public HTTP only",
    "No login or plugin",
    "Bounded scan deadline",
  ],
  howTitle: "How the scan works",
  howSteps: [
    {
      index: "01",
      title: "Enter a public URL",
      body: "No account is required. Syntax is checked before the request is accepted.",
    },
    {
      index: "02",
      title: "Watch real phases",
      body: "We show queued, running, partial, blocked, and failed states without a fake percent.",
    },
    {
      index: "03",
      title: "Use the diagnostic",
      body: "The teaser gives a useful baseline. A versioned backend result supplies score and coverage.",
    },
  ],
  reportTitle: "What you get back",
  reportLabel: "Example report",
  reportEyebrow: "Canonical check fixture",
  reportHeading: "No invented score",
  reportBody:
    "This preview uses canonical check IDs. A real score, level, coverage, and finding selection only render from the scan status DTO.",
  reportMethodologyLink: "Read the scoring methodology →",
  faqTitle: "Common questions",
  finalCta: "See what your public website makes readable.",
} as const;

export const LANDING_EXAMPLE_CHECKS = [
  { checkId: 13, name: "Agent-UA accessibility", status: "pass" },
  {
    checkId: 6,
    name: "Vertical structured-data quality",
    status: "partial",
  },
  { checkId: 11, name: "OAuth discovery", status: "not_applicable" },
] as const;

const sharedFaq = [
  {
    question: "Do you change anything on my site?",
    answer:
      "No. We use GET and HEAD to read public HTTP surfaces. We do not log in, run forms, bypass protections, or modify your site.",
  },
  {
    question: "Do you ask ChatGPT what it says about me?",
    answer:
      "No. This is an HTTP-readiness diagnostic, not a test of the answers produced by any particular model.",
  },
  {
    question: "Is the score a certification?",
    answer:
      "No. It is a versioned diagnostic level that helps orient the findings. It does not promise rankings, traffic, sales, or inclusion in a model.",
  },
  {
    question: "What if a check cannot complete?",
    answer:
      "We mark it unavailable. That means we could not reach a verdict; it is not counted as a confirmed failure.",
  },
] as const;

export const LANDINGS = {
  owner: {
    segment: "owner",
    variant: "owner-v2",
    locale: "en-US",
    eyebrow: "For online businesses",
    hero: {
      title:
        "See what your website shows to AI agents, and how to sell to them.",
      subtitle:
        "Scan a public address and read what an agent can find on your site: the business facts, the structured data, the machine-readable output, without pretending to test any model's answer. If what you sell can be delivered digitally, a merchant cabinet and an SDK take it from there.",
      cta: "Scan my site",
    },
    secondDoor: {
      lead: "Came here to sell?",
      label: "How selling to agents works",
      href: "/agentic-shop",
    },
    pains: [
      {
        title: "Discovery is changing",
        body: "AI summaries can change whether a person reaches a website at all, making readable source pages more important.",
        sourceIds: ["pew-ai-summary-clicks-2025"],
      },
      {
        title: "Business facts drift",
        body: "Owners report finding errors when they inspect how AI services represent their businesses.",
        sourceIds: ["squarespace-ai-search-business-owners-2026"],
      },
      {
        title: "You need an evidence-first baseline",
        body: "The useful first step is to inspect what your public HTTP surface actually contains — not buy a ranking promise.",
        sourceIds: ["squarespace-ai-search-business-owners-2026"],
      },
    ],
    faq: sharedFaq,
    reportPreviewFixture: "canonical-example-v1",
    segmentPhase: "Checking public business signals",
  },
  store: {
    segment: "store",
    variant: "store-v1",
    locale: "en-US",
    eyebrow: "For online stores",
    hero: {
      title: "Can agents read your products, prices, and stock correctly?",
      subtitle:
        "Inspect public catalog signals, product structured data, and agent-readable output. This does not execute or verify checkout.",
      cta: "Scan my store",
    },
    pains: [
      {
        title: "AI referrals are a real channel",
        body: "Retail analytics show fast growth in generative-AI referrals, while results still vary materially by site and journey.",
        sourceIds: ["adobe-retail-ai-traffic-2025"],
      },
      {
        title: "Catalog stacks are fragmented",
        body: "Woo stores commonly combine many plugins, so product facts cannot be assumed correct without checking the rendered result.",
        sourceIds: ["metorik-woo-statistics-2026"],
      },
      {
        title: "A diagnostic is not checkout proof",
        body: "We inspect prices, availability fields, and public feed signals. We never claim that a real order or payment would succeed.",
        sourceIds: ["adobe-retail-ai-traffic-2025"],
      },
    ],
    faq: sharedFaq,
    reportPreviewFixture: "canonical-example-v1",
    segmentPhase: "Checking catalog and commerce signals",
  },
  local: {
    segment: "local",
    variant: "local-v1",
    locale: "en-US",
    eyebrow: "For local and service businesses",
    hero: {
      title: "Can agents find your hours, services, and direct booking path?",
      subtitle:
        "Inspect the public signals that describe your business. We do not test live appointment slots or make bookings.",
      cta: "Scan my business",
    },
    pains: [
      {
        title: "Public details can be misread",
        body: "Small-business owners report errors in AI representations and uncertainty about where to begin correcting them.",
        sourceIds: ["squarespace-ai-search-business-owners-2026"],
      },
      {
        title: "Direct paths matter",
        body: "If contact and booking links are unclear, a customer can be routed through an intermediary instead of your owned channel.",
        sourceIds: ["restaurant-owner-booking-fee-example-2026"],
      },
      {
        title: "Owner examples are not averages",
        body: "Booking-fee pain is real, but varies by provider and contract. We label anecdotes instead of turning them into market claims.",
        sourceIds: ["restaurant-owner-booking-fee-example-2026"],
      },
    ],
    faq: sharedFaq,
    reportPreviewFixture: "canonical-example-v1",
    segmentPhase: "Checking local business signals",
  },
} as const satisfies Record<Segment, LandingConfig>;
