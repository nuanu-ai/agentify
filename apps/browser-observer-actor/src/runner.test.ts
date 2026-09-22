import { parseRobots } from "@agentify/scanner";
import { describe, expect, it } from "vitest";

import {
  authorizeMainFrameNavigation,
  permitsBrowserNavigation,
  permitsSearchPurpose,
  raceWithAbort,
  resolveActorBuild,
  runBrowserObservation,
  settleWithin,
} from "./runner.js";

describe("Actor build identity", () => {
  it("prefers the immutable configured build number over IDs", () => {
    expect(
      resolveActorBuild({
        APIFY_ACTOR_BUILD_NUMBER: "2026.07.13.1",
        ACTOR_BUILD_NUMBER: "2026.07.13.2",
        APIFY_ACTOR_BUILD_ID: "opaque-id",
        ACTOR_BUILD_ID: "other-id",
      }),
    ).toBe("2026.07.13.2");
    expect(
      resolveActorBuild({
        ACTOR_BUILD_NUMBER: "2026.07.13.2",
        APIFY_ACTOR_BUILD_ID: "opaque-id",
      }),
    ).toBe("2026.07.13.2");
    expect(
      resolveActorBuild({ APIFY_ACTOR_BUILD_NUMBER: "2026.07.13.1" }),
    ).toBe("2026.07.13.1");
  });

  it("fails closed before browser launch for a spoofed user agent", async () => {
    await expect(
      runBrowserObservation({
        actorBuild: "1",
        input: {
          schema_version: "browser-public-v1.0.0",
          operation_id: "019f5d64-1234-7abc-8abc-1234567890ab",
          target: {
            canonical_url: "https://example.com/",
            registrable_domain: "example.com",
            segment: "owner",
          },
          representative_urls: [],
          policy: {
            user_agent: "Mozilla/5.0",
            methods: ["GET", "HEAD"],
            use_proxy: false,
            respect_robots: true,
            crawl_purpose: "search",
          },
          limits: {
            max_pages: 1,
            max_requests_per_page: 10,
            max_total_bytes: 1_000_000,
            page_timeout_ms: 5_000,
            run_timeout_ms: 10_000,
          },
        },
      }),
    ).rejects.toThrow("user_agent_policy_mismatch");
  });
});

describe("search-purpose policy", () => {
  it("fails closed when Content-Signal explicitly denies search", () => {
    expect(
      permitsSearchPurpose(
        parseRobots("User-agent: *\nAllow: /\nContent-Signal: search=no"),
      ),
    ).toBe(false);
    expect(
      permitsSearchPurpose(
        parseRobots("User-agent: *\nAllow: /\nContent-Signal: search=yes"),
      ),
    ).toBe(true);
    expect(permitsSearchPurpose(parseRobots("User-agent: *\nAllow: /"))).toBe(
      true,
    );
  });

  it("rejects every disallowed main-frame path from the shared robots parse result", () => {
    const parsed = parseRobots(
      "User-agent: agentify-browser-observer\nDisallow: /private\nAllow: /",
    );
    expect(permitsBrowserNavigation(parsed, "/")).toBe(true);
    expect(permitsBrowserNavigation(parsed, "/private")).toBe(false);
    expect(permitsBrowserNavigation(parsed, "/private/js-navigation")).toBe(
      false,
    );
  });

  it("checks robots before redirect or script navigation can fetch content", async () => {
    for (const source of ["redirect", "script_navigation"] as const) {
      const events: string[] = [];
      const allowed = await authorizeMainFrameNavigation({
        isNavigation: true,
        isMainFrame: true,
        url: new URL(`https://example.com/private/${source}`),
        checkRobots: async (url) => {
          events.push(`robots:${url.pathname}`);
          return false;
        },
      });
      if (allowed) events.push("content_fetch");
      expect(allowed).toBe(false);
      expect(events).toEqual([`robots:/private/${source}`]);
    }
  });
});

describe("hard deadline", () => {
  it("rejects an in-flight extraction as soon as the run is aborted", async () => {
    const controller = new AbortController();
    const extraction = new Promise<never>(() => undefined);
    const raced = raceWithAbort(extraction, controller.signal);
    controller.abort();
    await expect(raced).rejects.toThrow("run_timeout");
  });

  it("does not wait forever for a stuck browser close", async () => {
    const startedAt = Date.now();
    await settleWithin(new Promise(() => undefined), 20);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
