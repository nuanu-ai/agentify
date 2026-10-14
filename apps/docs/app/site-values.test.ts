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
import { fillSiteValues, siteValuesIn } from "./site-values.js";

const identity = (await renderedPages()).get("/scanner")?.html ?? "";

const environments: [string, Environment][] = [
  ["the test channel", CHANNELS.test],
  ["the live channel", CHANNELS.live],
  [
    "a channel whose operator is published, with a name that needs escaping",
    {
      ...CHANNELS.live,
      LEGAL_OPERATOR: `O'Brien & "Sons" <Ltd>`,
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
    expect(siteValuesIn(servedTemplate())).toBeNull();
  });
});
