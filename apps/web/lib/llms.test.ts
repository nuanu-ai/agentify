import { afterEach, describe, expect, it } from "vitest";

import { PUBLIC_PAGE_PATHS } from "../content/public-page-metadata";
import { buildLlmsText } from "./llms";

const originalBaseUrl = process.env.NEXT_PUBLIC_APP_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined)
    delete process.env.NEXT_PUBLIC_APP_BASE_URL;
  else process.env.NEXT_PUBLIC_APP_BASE_URL = originalBaseUrl;
});

describe("llms.txt", () => {
  it("contains an H1 and only real absolute public links", () => {
    process.env.NEXT_PUBLIC_APP_BASE_URL = "https://agentify.ad";
    const body = buildLlmsText();
    const links = [...body.matchAll(/\[[^\]]+\]\((https:\/\/[^)]+)\)/g)].map(
      (match) => match[1],
    );

    expect(body).toMatch(/^# Agentify$/m);
    expect(links).toEqual(
      PUBLIC_PAGE_PATHS.map((path) => `https://agentify.ad${path}`),
    );
    expect(body).not.toMatch(/MCP|guarantee|certified/i);
  });
});
