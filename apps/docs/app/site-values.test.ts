/**
 * A page the browser draws after a move says what the page Caddy served would
 * have said: the browser fills the build's templates from the values Caddy
 * filled into the document it did serve, and must fill them as Caddy does,
 * on either channel and whether or not the operator's identity is published.
 * Caddy's filling is the one the edge's stand-in does from the same
 * environment.
 */

import { describe, expect, it } from "vitest";
import { type Environment, fillTemplates } from "../testing/caddy-templates.js";
import { CHANNELS } from "../testing/edge.js";
import { renderedPages } from "./markdown.server.js";
import { servedTemplate } from "./served.js";
import { analyticsConfigIn, fillSiteValues, siteValuesIn } from "./site-values.js";

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

/** Where a channel's measurements go, as its file may name them. */
const MEASURING = {
  ...CHANNELS.test,
  ANALYTICS_RUNTIME_ENV: "test",
  POSTHOG_BROWSER_KEY: "channel-browser-key",
  POSTHOG_BROWSER_HOST: "https://posthog.invalid",
  POSTHOG_DESTINATION_ENV: "test",
  META_PIXEL_ID: "1234567890",
  META_DESTINATION_ENV: "test",
};

const configOn = (environment: Environment) => {
  const values = siteValuesIn(fillTemplates(servedTemplate(), environment));
  if (values === null) throw new Error("the served part carried no values");
  return analyticsConfigIn(values);
};

describe("where a page's measurements go", () => {
  it("is where Caddy was told the scanner's go", () => {
    expect(configOn(MEASURING)).toEqual({
      runtimeEnvironment: "test",
      posthog: {
        key: "channel-browser-key",
        host: "https://posthog.invalid",
        destinationEnvironment: "test",
      },
      meta: { pixelId: "1234567890", destinationEnvironment: "test" },
    });
  });

  it.each(["ANALYTICS_RUNTIME_ENV", "POSTHOG_DESTINATION_ENV", "META_DESTINATION_ENV"])(
    "is nowhere when %s names an environment the scanner would refuse to start on",
    (name) => {
      expect(configOn({ ...MEASURING, [name]: "staging" })).toBeNull();
      expect(configOn({ ...MEASURING, [name]: "" })).toBeNull();
    },
  );
});
