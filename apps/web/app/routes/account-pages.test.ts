/**
 * The two pages where a person acts on their own address, drawn by the whole
 * process and read as the HTML a browser receives: what each offers before the
 * browser has asked who is signed in, the head that keeps them out of search
 * results, and that nobody keeps them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "../../testing/scanner";

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://agentify.ad");
  vi.stubEnv("PRIVACY_EMAIL", "privacy@example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const page = async (path: string) => {
  const answered = await ask(path, { headers: { accept: "text/html" } });
  const html = await answered.text();
  const head = html.slice(0, html.indexOf("</head>"));
  return {
    status: answered.status,
    cache: answered.headers.get("cache-control"),
    html,
    title: head.match(/<title>([^<]*)<\/title>/)?.[1],
    meta: (name: string) => head.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1],
  };
};

describe.each([
  ["/email/unsubscribe", "Email preferences · Agentify"],
  ["/data-request", "Data request · Agentify"],
])("%s", (path, title) => {
  it("is drawn under its own title, listed by no crawler and kept by nobody", async () => {
    const drawn = await page(path);

    expect(drawn.status).toBe(200);
    expect(drawn.title).toBe(title);
    expect(drawn.meta("robots")).toBe("noindex, nofollow");
    expect(drawn.cache).toBe("private, no-cache, no-store, max-age=0, must-revalidate");
  });

  it("offers nothing to press until the browser has asked who is signed in", async () => {
    const { html } = await page(path);

    expect(html).toContain("Finding out who is signed in");
    expect(html).not.toMatch(/<button\b[^>]*>(Unsubscribe|Request data access|Delete my data)/);
  });
});

describe("the data request page", () => {
  it("names the privacy address to write to, with the request's subject", async () => {
    const { html } = await page("/data-request");

    expect(html).toContain(
      'href="mailto:privacy@example.com?subject=Agentify%20data%20request">privacy@example.com</a>',
    );
  });

  it("tells the browser to send no address of it on to anywhere it leads", async () => {
    expect((await page("/data-request")).meta("referrer")).toBe("no-referrer");
  });
});
