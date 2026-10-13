/**
 * The icon and the manifest a page's head links to, asked of the whole process
 * over HTTP the way a browser follows those links: each address answers with
 * the type the link or the manifest claims for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "../../testing/scanner";

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://agentify.ad");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const REVALIDATED = "public, max-age=0, must-revalidate";

/** The `<link>` of this kind in the front page's head. */
const headLink = async (rel: string) => {
  const html = await (await ask("/", { headers: { accept: "text/html" } })).text();
  const tag = html.slice(0, html.indexOf("</head>")).match(new RegExp(`<link rel="${rel}"[^>]*>`));
  const attribute = (name: string) => tag?.[0].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  return { href: attribute("href") ?? "", type: attribute("type") };
};

type Manifest = {
  name: string;
  short_name: string;
  start_url: string;
  icons: { src: string; type: string }[];
};

describe("the site's icon", () => {
  it("is the SVG a page's head links to, kept by a cache that asks again", async () => {
    const link = await headLink("icon");
    const answered = await ask(link.href);

    expect(answered.status).toBe(200);
    expect(answered.headers.get("content-type")).toBe(link.type);
    expect(answered.headers.get("cache-control")).toBe(REVALIDATED);
    expect(await answered.text()).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });
});

describe("the manifest", () => {
  it("is what a page's head links to: the site's names, opening at the front page", async () => {
    const answered = await ask((await headLink("manifest")).href);

    expect(answered.status).toBe(200);
    expect(answered.headers.get("content-type")).toMatch(/^application\/manifest\+json\b/);
    expect(answered.headers.get("cache-control")).toBe(REVALIDATED);
    expect((await answered.json()) as Manifest).toMatchObject({
      name: "Agentify website diagnostic",
      short_name: "Agentify",
      start_url: "/",
    });
  });

  it("names icons that are answered with the type it claims for them", async () => {
    const { icons } = (await (await ask("/manifest.webmanifest")).json()) as Manifest;

    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      const answered = await ask(icon.src);
      expect(answered.status, icon.src).toBe(200);
      expect(answered.headers.get("content-type"), icon.src).toBe(icon.type);
    }
  });
});

describe("the icon and the manifest", () => {
  it.each(["/icon.svg", "/manifest.webmanifest"])("are read alone: %s", async (path) => {
    expect((await ask(path, { method: "POST" })).status).toBe(405);
  });
});
