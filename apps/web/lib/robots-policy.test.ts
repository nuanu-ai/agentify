import { explicitAiPolicies, isPathAllowed, parseRobots } from "@agentify/scanner";
import { afterEach, describe, expect, it } from "vitest";

import { buildRobotsPolicy, PRIVATE_ROBOTS_PATHS } from "./robots-policy";

const originalBaseUrl = process.env.APP_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalBaseUrl;
});

describe("Agentify robots policy", () => {
  it("passes the canonical robots, AI-policy and Content-Signal parsers", () => {
    process.env.APP_BASE_URL = "https://agentify.ad";
    const body = buildRobotsPolicy();
    const parsed = parseRobots(body);

    expect(parsed.fatal).toBe(false);
    expect(parsed.malformedDirectives).toBe(0);
    expect(parsed.contentSignalMalformed).toBe(false);
    expect(parsed.contentSignal).toEqual({
      search: "yes",
      "ai-input": "yes",
      "ai-train": "no",
    });
    expect(Object.keys(explicitAiPolicies(parsed))).toEqual([
      "openai",
      "anthropic",
      "perplexity",
      "google",
    ]);
    expect(parsed.sitemaps).toEqual(["https://agentify.ad/sitemap.xml"]);
    expect(isPathAllowed(parsed, "agentify-scanner/1.0", "/owner")).toBe(true);
    for (const path of PRIVATE_ROBOTS_PATHS)
      expect(isPathAllowed(parsed, "agentify-scanner/1.0", path)).toBe(false);
    expect(isPathAllowed(parsed, "GPTBot/1.0", "/owner")).toBe(false);
    expect(isPathAllowed(parsed, "Google-Extended", "/owner")).toBe(false);
    expect(isPathAllowed(parsed, "OAI-SearchBot/1.0", "/owner")).toBe(true);
  });

  it("keeps crawler rules aligned when training is explicitly allowed", () => {
    const parsed = parseRobots(
      buildRobotsPolicy({ search: "yes", aiInput: "yes", aiTrain: "yes" }),
    );

    expect(parsed.contentSignal?.["ai-train"]).toBe("yes");
    expect(isPathAllowed(parsed, "GPTBot/1.0", "/owner")).toBe(true);
    expect(isPathAllowed(parsed, "GPTBot/1.0", "/admin")).toBe(false);
  });
});
