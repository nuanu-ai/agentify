/**
 * What the scanner adds to its answers by their address, whatever route drew
 * them, asked of the whole process over HTTP: the security headers, the
 * private places, the public pages and their Markdown, the page for an address
 * it does not have, and the line a failure leaves in the log.
 */

import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ask, testScanner } from "../testing/scanner";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const NOBODY_KEEPS = "private, no-cache, no-store, max-age=0, must-revalidate";

/** The text of the first element of this kind on a page, or null. */
const textOf = (tag: "title" | "h1", html: string): string | null =>
  html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.replace(/<[^>]+>/g, "") ??
  null;

describe("every answer", () => {
  it.each([
    ["a public page", "/", "GET"],
    ["a page's data", "/methodology.data", "GET"],
    ["an API route", "/api/health/live", "GET"],
    ["a method an API route does not take", "/api/health/live", "POST"],
    ["an address the scanner has no page for", "/no-such-page", "GET"],
    ["a scan", "/scan/0190f4c5-0000-7000-8000-000000000000", "GET"],
    ["an address with a trailing slash", "/methodology/", "GET"],
    ["an address that cannot be decoded", "/%E0%A4%A", "GET"],
  ])(
    "carries the security headers and does not name its server: %s",
    async (_what, path, method) => {
      const answered = await ask(path, { method });

      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(answered.headers.get(name), name).toBe(value);
      }
      expect(answered.headers.get("x-powered-by")).toBeNull();
    },
  );
});

describe("a scan and a report", () => {
  it.each([
    ["/scan", "no-referrer"],
    ["/scan/0190f4c5-0000-7000-8000-000000000000", "no-referrer"],
    ["/scan/pending.data", "no-referrer"],
    ["/report/0190f4c5-0000-7000-8000-000000000000", "strict-origin"],
    ["/sc%61n/0190f4c5-0000-7000-8000-000000000000", "no-referrer"],
    ["/%73can/pending.data", "no-referrer"],
    ["/rep%6Frt/0190f4c5-0000-7000-8000-000000000000", "strict-origin"],
  ])(
    "are kept by nobody, leave no address behind and are indexed by no crawler, however the address is spelled: %s",
    async (path, referrer) => {
      const answered = await ask(path);

      expect(answered.headers.get("cache-control")).toBe("private, no-store");
      expect(answered.headers.get("referrer-policy")).toBe(referrer);
      expect(answered.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    },
  );

  it("are not where a slash is written encoded, which the router reads as no step of the path", async () => {
    const answered = await ask("/scan%2F0190f4c5-0000-7000-8000-000000000000");

    expect(answered.status).toBe(404);
    expect(answered.headers.get("referrer-policy")).toBeNull();
    expect(answered.headers.get("x-robots-tag")).toBeNull();
  });

  it("are a place of their own, so the public page about the scanner is not one of them", async () => {
    const answered = await ask("/scanner");

    expect(answered.headers.get("referrer-policy")).toBeNull();
    expect(answered.headers.get("x-robots-tag")).toBeNull();
  });
});

describe("a public page", () => {
  it.each(["/", "/store", "/local", "/methodology", "/scanner", "/privacy", "/terms"])(
    "may be kept by a shared cache for an hour, in English, by its Accept: %s",
    async (path) => {
      const answered = await ask(path, { headers: { accept: "text/html" } });

      expect(answered.status).toBe(200);
      expect(answered.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(answered.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=3600");
      expect(answered.headers.get("content-language")).toBe("en-US");
      expect(answered.headers.get("vary")).toMatch(/\baccept\b/i);
    },
  );

  it.each(["/", "/store", "/local", "/methodology", "/scanner", "/privacy", "/terms"])(
    "is Markdown for a client that prefers it, kept the same way: %s",
    async (path) => {
      const answered = await ask(path, { headers: { accept: "text/markdown, text/html;q=0.9" } });
      const body = await answered.text();

      expect(answered.status).toBe(200);
      expect(answered.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(answered.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=3600");
      expect(answered.headers.get("content-language")).toBe("en-US");
      expect(answered.headers.get("vary")).toBe("Accept");
      expect(body).toMatch(/^# \S/);
      expect(body).not.toContain("<html");
    },
  );

  it("is kept and offered as Markdown the same way where its address is percent-encoded", async () => {
    const page = await ask("/m%65thodology", { headers: { accept: "text/html" } });
    const markdown = await ask("/m%65thodology", { headers: { accept: "text/markdown" } });
    const data = await ask("/m%65thodology.data");

    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=3600");
    expect(page.headers.get("content-language")).toBe("en-US");
    expect(page.headers.get("vary")).toMatch(/\baccept\b/i);
    expect(markdown.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(data.headers.get("cache-control")).toBe("public, max-age=10");
  });

  it("answers a HEAD for its Markdown with the Markdown's headers and no body", async () => {
    const answered = await ask("/methodology", {
      method: "HEAD",
      headers: { accept: "text/markdown" },
    });

    expect(answered.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await answered.text()).toBe("");
  });

  it.each([
    ["refuses Markdown", "text/markdown;q=0, text/html"],
    ["prefers HTML", "text/html, text/markdown;q=0.5"],
    ["names no Markdown", "*/*"],
  ])("is HTML for a client that %s", async (_what, accept) => {
    const answered = await ask("/", { headers: { accept } });

    expect(answered.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("is a page kept by nobody for a prefetch, even one that asks for Markdown", async () => {
    const answered = await ask("/", { headers: { accept: "text/markdown", purpose: "prefetch" } });

    expect(answered.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(answered.headers.get("cache-control")).toBe(NOBODY_KEEPS);
  });

  it.each([
    ["/_.data", {}],
    ["/methodology.data", {}],
    ["/methodology.data", { purpose: "prefetch" }],
  ])(
    "has data a browser may keep for a moment, so a hover's fetch serves the click: %s %o",
    async (path, headers) => {
      const answered = await ask(path, { headers });

      expect(answered.status).toBe(200);
      expect(answered.headers.get("cache-control")).toBe("public, max-age=10");
    },
  );

  it("is neither Markdown nor kept anywhere where the address is no public page", async () => {
    const answered = await ask("/no-such-page", { headers: { accept: "text/markdown" } });

    expect(answered.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(answered.headers.get("cache-control")).toBe(NOBODY_KEEPS);
    expect((await ask("/no-such-page.data")).headers.get("cache-control")).toBe(NOBODY_KEEPS);
  });
});

describe("an address the scanner has no page for", () => {
  it.each([
    ["read", "/no-such-page", "GET"],
    ["posted to", "/no-such-page", "POST"],
    ["under the API", "/api/no-such-route", "GET"],
    ["spelled in another case", "/METHODOLOGY", "GET"],
  ])("is the site's page that says so, with status 404, when %s", async (_how, path, method) => {
    const answered = await ask(path, { method });
    const html = await answered.text();

    expect(answered.status).toBe(404);
    expect(answered.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(answered.headers.get("cache-control")).toBe(NOBODY_KEEPS);
    expect(textOf("h1", html)).toBe("Page not found");
    expect(html).toContain('<meta name="robots" content="noindex"/>');
  });

  it("answers a HEAD with status 404", async () => {
    expect((await ask("/no-such-page", { method: "HEAD" })).status).toBe(404);
  });

  it("is a plain 404, kept by nobody, where the address cannot be decoded", async () => {
    const answered = await ask("/%E0%A4%A");

    expect(answered.status).toBe(404);
    expect(answered.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(answered.headers.get("cache-control")).toBe(NOBODY_KEEPS);
    expect(answered.headers.get("etag")).toBeNull();
  });

  it.each([
    ["read", "/api/health/live.data", "GET"],
    ["posted to", "/api/v1/consent.data", "POST"],
  ])(
    "is a 404, and leaves no line in the log, where it asks for an API route's data as a page's: %s",
    async (_how, path, method) => {
      const lines: string[] = [];
      vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        lines.push(String(line));
      });

      const answered = await ask(path, {
        method,
        headers: { origin: "http://localhost:3000", "content-type": "text/plain" },
        ...(method === "POST" ? { body: "x" } : {}),
      });

      expect(answered.status).toBe(404);
      expect(answered.headers.get("cache-control")).toBe(NOBODY_KEEPS);
      expect(lines).toEqual([]);
    },
  );
});

describe("a page asked with a method it does not take", () => {
  it.each(["PUT", "DELETE", "OPTIONS"])(
    "is refused with 405 naming the methods it takes: %s",
    async (method) => {
      const answered = await ask("/methodology", { method });

      expect(answered.status).toBe(405);
      expect(answered.headers.get("allow")).toBe("GET, HEAD");
      expect(answered.headers.get("cache-control")).toBe(NOBODY_KEEPS);
    },
  );
});

describe("an address with a trailing slash", () => {
  it("is sent permanently to the one without it, the query kept", async () => {
    const answered = await ask("/methodology/?from=a-link");

    expect(answered.status).toBe(308);
    expect(answered.headers.get("location")).toBe("/methodology?from=a-link");
  });

  it("leaves the front page where it is", async () => {
    expect((await ask("/")).status).toBe(200);
  });
});

/** Where the scanner sends a path as written, slashes and all, which `fetch` would tidy first. */
const sentFrom = async (path: string): Promise<{ status: number; location?: string }> => {
  const { origin } = await testScanner();
  return new Promise((resolve, reject) => {
    request(`${origin}/`, { path, agent: false }, (answered) => {
      answered.resume();
      resolve({
        status: answered.statusCode ?? 0,
        ...(answered.headers.location === undefined ? {} : { location: answered.headers.location }),
      });
    })
      .on("error", reject)
      .end();
  });
};

describe("an address written with repeated slashes", () => {
  it.each([
    ["//elsewhere.example/", "/elsewhere.example/"],
    ["//elsewhere.example", "/elsewhere.example"],
    ["/\\elsewhere.example/", "/elsewhere.example/"],
    ["/methodology//?from=a-link", "/methodology/?from=a-link"],
  ])(
    "is sent to the same address on this site with one slash at each step: %s",
    async (path, to) => {
      const answered = await sentFrom(path);

      expect(answered.status).toBe(308);
      expect(answered.location).toBe(to);
    },
  );
});

describe("a request that fails where nothing caught it", () => {
  it("is answered 500, kept by no cache, and leaves one line naming the failure by its kind, never by its message", async () => {
    // A browser PostHog key with no host is refused while the root's loader
    // reads the configuration, so every page fails to draw.
    vi.stubEnv("POSTHOG_BROWSER_KEY", "phc_configured_without_a_host");
    vi.stubEnv("POSTHOG_BROWSER_HOST", "");
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const answered = await ask("/methodology", {
      headers: { "x-request-id": "0190f4c5-1111-7222-8333-944455556666" },
    });

    expect(answered.status).toBe(500);
    expect(answered.headers.get("cache-control")).toBe(NOBODY_KEEPS);
    const logged = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.event === "web_unhandled_request_error");
    expect(logged).toEqual([
      expect.objectContaining({
        request_id: "0190f4c5-1111-7222-8333-944455556666",
        route: "page_trust",
        method: "GET",
        error_type: "Error",
      }),
    ]);
    expect(lines.join("\n")).not.toContain("browser_posthog_requires_key_and_host");
  });
});
