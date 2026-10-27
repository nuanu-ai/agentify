// @vitest-environment jsdom
/**
 * What the gallery's page promises the host that publishes it and the person
 * who comments on it: it holds every file a screen needs, since the host lets
 * it fetch nothing; it writes no document skeleton of its own and names itself
 * within the part of the file the host reads for a title; and it refuses
 * states a comment could not point at. Drawing a real surface is held by that
 * surface's own gallery check and by `pnpm gallery` in CI.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DrawnState, type DrawnSurface, finderIn, withFilesInlined } from "./draw.js";
import { pageOf, refusalsIn } from "./page.js";

const state = (id: string, more: Partial<DrawnState> = {}): DrawnState => ({
  id,
  screen: "API keys",
  address: "/dashboard/keys",
  when: "A merchant opens API keys before creating any.",
  cause: "The gateway lists no keys for the merchant.",
  html: "<h1>API keys</h1>",
  ...more,
});

const surface = (states: readonly DrawnState[], css = ""): DrawnSurface => ({
  id: "dashboard",
  name: "Seller dashboard",
  lang: "en",
  css,
  states,
});

describe("a stylesheet's files in the published page", () => {
  it("carries inside itself every file a screen's stylesheet points at, wherever the file lives", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gallery-"));
    await writeFile(join(folder, "face.woff2"), "a face");
    const find = finderIn("/dashboard/", [folder]);

    const inlined = await withFilesInlined(
      `a { src: url("/dashboard/@fs${folder}/face.woff2"); } b { src: url(/face.woff2); }`,
      find,
    );

    const embedded = `url("data:font/woff2;base64,${Buffer.from("a face").toString("base64")}")`;
    expect(inlined).toBe(`a { src: ${embedded}; } b { src: ${embedded}; }`);
  });

  it("refuses a file on another site, which the page could only fetch", async () => {
    await expect(
      withFilesInlined('a { src: url("https://fonts.example.com/face.woff2"); }', () => null),
    ).rejects.toThrow(/fonts\.example\.com/);
  });

  it("refuses a file it cannot find, rather than a page that silently lacks it", async () => {
    await expect(withFilesInlined("a { src: url(/missing.woff2); }", () => null)).rejects.toThrow(
      /missing\.woff2/,
    );
  });
});

describe("the page the host publishes", () => {
  const parts = (surfaces: readonly DrawnSurface[]) => ({
    surfaces,
    fonts: `@font-face { src: url("data:font/woff2;base64,${"A".repeat(200_000)}"); }`,
    css: "body { margin: 0; }",
    script: "void 0;",
    mark: "data:image/svg+xml;base64,PHN2Zy8+",
  });

  it("writes no document of its own and names itself in the first 8 KB, however large it grows", () => {
    const page = pageOf(
      parts([surface([state("dashboard-keys-none")], `a { color: red; }${" ".repeat(300_000)}`)]),
    );

    expect(page).not.toMatch(/<!doctype|<(?:html|head|body)[\s>]/i);
    const title = /<title>([^<]+)<\/title>/.exec(page);
    expect((title?.[1] ?? "").trim().length).toBeGreaterThan(0);
    const end = page.indexOf("</title>");
    expect(end).toBeGreaterThan(0);
    expect(Buffer.byteLength(page.slice(0, end + "</title>".length))).toBeLessThan(8 * 1024);
  });

  it("refuses to grow past what the host publishes", () => {
    expect(() =>
      pageOf(parts([surface([state("dashboard-keys-none")], "a".repeat(17 * 1024 * 1024))])),
    ).toThrow(/more than the \d+ the host publishes/);
  });

  it("carries each state's markup where no browser reads it as the page's own", () => {
    const page = pageOf(
      parts([
        surface([state("dashboard-keys-none", { html: "<script>x()</script><h1>Keys</h1>" })]),
      ]),
    );

    expect(page).not.toContain("<script>x()</script>");
    const document = new DOMParser().parseFromString(page, "text/html");
    const embedded = document.querySelector("script#gallery-data");
    expect(embedded?.getAttribute("type")).toBe("application/json");
    const data = JSON.parse(embedded?.textContent ?? "null");
    expect(data.states["dashboard-keys-none"]).toEqual({
      surface: "dashboard",
      html: "<script>x()</script><h1>Keys</h1>",
      shows: null,
    });
    expect(document.querySelector("article#dashboard-keys-none")).not.toBeNull();
    expect(document.querySelector("article#dashboard-keys-none script")).toBeNull();
  });
});

describe("states a comment could not point at", () => {
  it("refuses a state named twice", () => {
    expect(
      refusalsIn([surface([state("dashboard-keys-none"), state("dashboard-keys-none")])]),
    ).toEqual([expect.stringMatching(/dashboard-keys-none.*(?:twice|duplicat)/i)]);
  });

  it("refuses a name the host would not pass on as an anchor, or one outside its surface", () => {
    expect(refusalsIn([surface([state("dashboard-keys none"), state("keys-none")])])).toEqual([
      expect.stringMatching(/dashboard-keys none.*anchor/i),
      expect.stringMatching(/keys-none.*dashboard/i),
    ]);
  });

  it("refuses a screen that asks for a file by address, which the host would block", () => {
    expect(
      refusalsIn([
        surface([
          state("dashboard-keys-none", {
            html:
              '<img src="/assets/mark.svg"><img src="data:image/svg+xml;base64,PHN2Zy8+"' +
              ' srcSet="data:image/webp;base64,UklG 640w, /still-life-1448.webp 1448w">' +
              '<link rel="canonical" href="https://agentify.ad/store">' +
              '<link rel="icon" href="/icon.svg">',
          }),
        ]),
      ]),
    ).toEqual([
      "The state dashboard-keys-none asks for /assets/mark.svg, which the page cannot fetch.",
      "The state dashboard-keys-none asks for /icon.svg, which the page cannot fetch.",
      "The state dashboard-keys-none asks for /still-life-1448.webp, which the page cannot fetch.",
    ]);
  });

  it("refuses a state that does not say where, when or why", () => {
    const refusals = refusalsIn([
      surface([state("dashboard-keys-none", { screen: "", when: " ", cause: "", address: "" })]),
    ]);
    expect(refusals).toHaveLength(4);
    for (const field of ["screen", "address", "when", "cause"])
      expect(refusals).toContainEqual(
        expect.stringMatching(new RegExp(`dashboard-keys-none.*${field}`)),
      );
  });
});
