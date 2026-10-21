import { DOCS_PAGES } from "@agentify/ui/docs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_PAGE_PATHS } from "../content/public-page-metadata";
import { buildLlmsText } from "./llms";

const LIVE = "https://agentify.ad";
const TEST = "https://test.agentify.ad";

/** The text as one channel's scanner answers it. */
const on = (origin: string, mode: string | undefined): string => {
  vi.stubEnv("APP_BASE_URL", origin);
  vi.stubEnv("AGENTIFY_SURFACE_MODE", mode);
  return buildLlmsText();
};

const linksIn = (body: string): string[] =>
  [...body.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g)].map((match) => match[1] ?? "");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("llms.txt", () => {
  it("contains an H1 and only real absolute public links, the documentation's pages among them", () => {
    const body = on(LIVE, "live");

    expect(body).toMatch(/^# Agentify$/m);
    expect(linksIn(body)).toEqual([
      ...PUBLIC_PAGE_PATHS.map((path) => `${LIVE}${path}`),
      // Every page of the documentation, the scanner's own among them.
      `${LIVE}/docs/`,
      ...DOCS_PAGES.slice(1).map((page) => `${LIVE}/docs${page.path}`),
      `${LIVE}/agentic-shop`,
      // An agent that came to buy, rather than to read about selling, is
      // given the catalogue it buys from.
      `${LIVE}/x402/catalog`,
    ]);
    expect(body).not.toMatch(/MCP|guarantee|certified/i);
  });

  it("tells an agent how to buy from the catalogue, in the names the wire uses", () => {
    // The catalogue lists products and prices. An agent that cannot find how
    // to buy one, what answers its payment and what to keep to itself leaves,
    // or guesses; these are the names it has to act on.
    const selling = on(LIVE, "live").split("## Selling to agents")[1] ?? "";

    for (const name of [
      "purchase_url",
      '{"params":',
      "PAYMENT-REQUIRED",
      "PAYMENT-SIGNATURE",
      "status_url",
      "delivered",
      "order_id",
    ]) {
      expect(selling, name).toContain(name);
    }
  });

  it("on the live channel, opens with the site's name and says nothing of test money", () => {
    const body = on(LIVE, "live");

    expect(body.split("\n")[0]).toBe("# Agentify");
    expect(body).not.toMatch(/test channel|test money|sandbox|Base Sepolia/i);
  });

  it("on the test channel, says on its first line that it is the test channel, paid in test money on Base Sepolia, and names the live site", () => {
    const [first] = on(TEST, "test").split("\n");

    expect(first).toMatch(/^# /);
    expect(first).toMatch(/test channel/i);
    expect(first).toMatch(/test money/i);
    expect(first).toMatch(/Base Sepolia/);
    expect(first).toContain(LIVE);
  });

  it("on the test channel, links only to this channel and names the live site by its bare origin alone", () => {
    // An agent on the test channel that follows a link to the live site reads
    // another release's instructions, and buys with real money.
    const test = on(TEST, "test");

    const [first = "", ...rest] = test.split("\n");
    // Every mention of the live site's name, with or without a scheme or a path.
    const liveNamed = (text: string): string[] =>
      text.replaceAll(TEST, "").match(/agentify\.ad\S*/gi) ?? [];

    expect(linksIn(test).length).toBeGreaterThan(0);
    for (const link of linksIn(test)) expect(link.startsWith(`${TEST}/`), link).toBe(true);
    expect(first).toContain(LIVE);
    expect(liveNamed(first)).toEqual(["agentify.ad"]);
    expect(liveNamed(rest.join("\n"))).toEqual([]);
    expect(linksIn(test)).toContain(`${TEST}/x402/catalog`);
  });

  it.each([
    ["the test channel", TEST, "test"],
    ["a stack that names no channel, as on a laptop", "http://localhost:8080", undefined],
    ["a sandbox", "http://localhost:8080", "sandbox"],
  ])(
    "on %s, tells an agent how to buy exactly as the live site of the same release does, after its own opening",
    (_, origin, mode) => {
      // The test channel is where a release is tried before it is live: an
      // agent there reads that release's instructions, not the live site's.
      // The live text is its name and then nothing but what every channel says.
      const here = on(origin, mode);
      const live = on(LIVE, "live").replaceAll(LIVE, origin);

      expect(live.startsWith("# Agentify\n")).toBe(true);
      expect(here.endsWith(live.slice("# Agentify".length))).toBe(true);
      expect(here).not.toBe(live);
    },
  );

  it.each([
    ["no channel is named", undefined],
    ["the stack names itself a sandbox", "sandbox"],
  ])(
    "where %s, as on a laptop, says on its first line that no payment there is real and names the live site",
    (_, mode) => {
      const [first] = on("http://localhost:8080", mode).split("\n");

      expect(first).toMatch(/^# /);
      expect(first).toMatch(/sandbox/i);
      expect(first).toContain(LIVE);
    },
  );
});
