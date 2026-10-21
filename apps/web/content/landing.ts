import type { Segment } from "@agentify/scanner-contracts";

export type LandingConfig = Readonly<{
  segment: Segment;
  variant: string;
  locale: "en-US" | "ru-RU";
  eyebrow: string;
  hero: Readonly<{ title: string; subtitle: string; cta: string }>;
  /**
   * One line under the scan form for the person who came to sell rather than
   * to scan: a lead-in and a link to the page about selling to agents.
   */
  secondDoor: Readonly<{ lead: string; label: string; href: string }>;
  segmentPhase: string;
}>;

export const LANDING_SHARED_CONTENT = {
  assurances: [
    "Public HTTP only",
    "No login or plugin",
    "Nothing on your site is changed",
    "Bounded scan deadline",
  ],
  howTitle: "How the scan works",
  howSteps: [
    {
      index: "01",
      title: "Enter a public URL",
      body: "No account. We check the address first.",
    },
    {
      index: "02",
      title: "Watch real phases",
      body: "Queued, running, partial, blocked or no result. Never a percent.",
    },
    {
      index: "03",
      title: "Use the diagnostic",
      body: "A score, the findings, and what to fix.",
    },
  ],
  reportTitle: "What you get back",
  reportLabel: "Example report",
  reportHeading: "No invented score",
  reportMethodologyLink: "How the scan works and what it does not do →",
  finalCta: "See what your public website makes readable.",
  /**
   * The line under the second door for an agent sent to buy: where it starts,
   * which is a file the scanner serves, not one of its pages.
   */
  agentDoor: {
    lead: "An agent that buys starts at",
    label: "/llms.txt",
    href: "/llms.txt",
    rest: ", which names the catalog.",
  },
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

/**
 * The line for a business that arrived at a scan landing made for its kind:
 * what the scan has to do with selling, which is nothing it waits on.
 */
const SELLING_APART_FROM_THE_SCAN = {
  lead: "Selling to agents runs through Agentify and does not depend on this scan.",
  label: "How selling to agents works",
  href: "/agentic-shop",
} as const;

export const LANDINGS = {
  owner: {
    segment: "owner",
    variant: "owner-v2",
    locale: "en-US",
    eyebrow: "For online businesses",
    hero: {
      title: "See what your website shows to AI agents, and how to sell to them.",
      subtitle: "We read what your site makes public. We do not test any model's answer.",
      cta: "Scan my site",
    },
    secondDoor: {
      lead: "Came here to sell?",
      label: "How selling to agents works",
      href: "/agentic-shop",
    },
    segmentPhase: "Checking public business signals",
  },
  store: {
    segment: "store",
    variant: "store-v1",
    locale: "en-US",
    eyebrow: "For online stores",
    hero: {
      title: "Can agents read your products, prices, and stock correctly?",
      subtitle: "We read your public product pages. We do not place an order or test checkout.",
      cta: "Scan my store",
    },
    secondDoor: SELLING_APART_FROM_THE_SCAN,
    segmentPhase: "Checking catalog and commerce signals",
  },
  local: {
    segment: "local",
    variant: "local-v1",
    locale: "en-US",
    eyebrow: "For local and service businesses",
    hero: {
      title: "Can agents find your hours, services, and direct booking path?",
      subtitle: "We read your public pages. We do not make a booking or test open slots.",
      cta: "Scan my business",
    },
    secondDoor: SELLING_APART_FROM_THE_SCAN,
    segmentPhase: "Checking local business signals",
  },
} as const satisfies Record<Segment, LandingConfig>;
