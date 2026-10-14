/**
 * A page the browser draws after a move says what the page Caddy served would
 * have said: the browser fills the build's templates from the values Caddy
 * filled into the document it did serve, and must fill them as Caddy does,
 * on either channel and whether or not the operator's identity is published.
 * Caddy's filling is the one the edge's stand-in does from the same
 * environment.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Environment, fillTemplates } from "../testing/caddy-templates.js";
import { CHANNELS } from "../testing/edge.js";
import { renderedPages } from "./markdown.server.js";
import { servedTemplate } from "./served.js";
import { fillSiteValues, siteValuesIn } from "./site-values.js";

const identity = (await renderedPages()).get("/scanner")?.html ?? "";

const environments: [string, Environment][] = [
  ["the test channel", CHANNELS.test],
  ["the live channel", CHANNELS.live],
  [
    "a channel whose operator is published, with a name that needs escaping",
    {
      ...CHANNELS.live,
      LEGAL_OPERATOR: `O'Brien & "Sons" <Ltd> $& co`,
      LEGAL_IDENTITY_CONFIRMED: "true",
    },
  ],
];

describe("the values a deployment decides", () => {
  it.each(environments)(
    "are read back from the document Caddy served on %s",
    (_on, environment) => {
      expect(siteValuesIn(fillTemplates(servedTemplate(), environment))).toEqual({
        origin: environment.AGENTIFY_PUBLIC_ORIGIN,
        "abuse-email": environment.ABUSE_EMAIL,
        operator: environment.LEGAL_OPERATOR,
        "identity-confirmed": environment.LEGAL_IDENTITY_CONFIRMED,
        "analytics-runtime": environment.ANALYTICS_RUNTIME_ENV ?? "",
        "posthog-key": environment.POSTHOG_BROWSER_KEY ?? "",
        "posthog-host": environment.POSTHOG_BROWSER_HOST ?? "",
        "posthog-destination": environment.POSTHOG_DESTINATION_ENV ?? "",
        "meta-pixel": environment.META_PIXEL_ID ?? "",
        "meta-destination": environment.META_DESTINATION_ENV ?? "",
      });
    },
  );

  it.each(environments)(
    "fill a page in the browser as Caddy fills it on %s",
    (_on, environment) => {
      const values = siteValuesIn(fillTemplates(servedTemplate(), environment));
      if (values === null) throw new Error("the served part carried no values");

      expect(identity).toContain("<!--{{");
      expect(fillSiteValues(identity, values)).toBe(fillTemplates(identity, environment));
    },
  );

  it("are not read where nobody filled them, so the build's templates stay for Caddy", () => {
    // As the build writes them, and as a browser writes them back from a
    // document nobody filled, `<` and `>` in an attribute as entities.
    const readBack = servedTemplate()
      .replace(
        /="(<!--\{\{[^"]*)"/g,
        (_whole, value: string) => `="${value.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}"`,
      )
      .replace("<div hidden id=", '<div hidden="" id=');

    expect(siteValuesIn(servedTemplate())).toBeNull();
    expect(readBack).toContain('data-origin="&lt;!--{{');
    expect(siteValuesIn(readBack)).toBeNull();
  });
});

/** One service's environment as a compose file writes it, each variable with its expression. */
const environmentOf = (file: string, service: string): ReadonlyMap<string, string> => {
  const compose = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
  const block = new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|^\\S)`, "m").exec(
    compose,
  )?.[1];
  const environment = /^ {4}environment:\n((?: {6}.*\n|\s*\n)+)/m.exec(block ?? "")?.[1] ?? "";
  return new Map(
    [...environment.matchAll(/^ {6}([A-Z_]+): (.+)$/gm)].map(([, name = "", value = ""]) => [
      name,
      value,
    ]),
  );
};

/** Where the scanner's pages and the documentation's measurements go. */
const ANALYTICS = [
  "ANALYTICS_RUNTIME_ENV",
  "POSTHOG_BROWSER_KEY",
  "POSTHOG_BROWSER_HOST",
  "POSTHOG_DESTINATION_ENV",
  "META_PIXEL_ID",
  "META_DESTINATION_ENV",
];

describe("what Caddy fills the documentation with", () => {
  it("is what the scanner is given, so its own pages and the documentation's say the same", () => {
    const caddy = environmentOf("compose.yaml", "web");
    const scanner = environmentOf("compose.yaml", "scanner");

    expect(caddy.get("AGENTIFY_PUBLIC_ORIGIN")).toBe(scanner.get("APP_BASE_URL"));
    for (const name of [
      "ABUSE_EMAIL",
      "LEGAL_OPERATOR",
      "LEGAL_IDENTITY_CONFIRMED",
      ...ANALYTICS,
    ]) {
      expect(caddy.get(name), name).toBe(scanner.get(name));
    }
    expect(scanner.size).toBeGreaterThan(10);
  });

  it.each(["deploy/compose.agentify-test.yaml", "deploy/compose.hetzner-commerce.yaml"])(
    "sends the documentation's page views where %s sends the scanner's",
    (file) => {
      const caddy = environmentOf(file, "web");
      const scanner = environmentOf(file, "scanner");
      const named = ANALYTICS.filter((name) => scanner.has(name) || caddy.has(name));

      expect(named.length).toBeGreaterThan(0);
      for (const name of named) expect(caddy.get(name), name).toBe(scanner.get(name));
    },
  );
});
