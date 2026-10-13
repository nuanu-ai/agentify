/**
 * The pictures the scanner draws for the site, asked of the whole process over
 * HTTP and read the way a crawler reads them: the type and size a page's head
 * claims, and the PNG behind the address it names. The drawing itself is asked
 * for the characters the brand's fonts lack.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELL_TO_AGENTS_PICTURE } from "../../content/pictures";
import { drawPng, MONO_FONT } from "../../lib/server/drawing";
import { ask } from "../../testing/scanner";

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", "https://agentify.ad");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The size a PNG says it is, from its header, after checking it is one. */
const pngSize = (bytes: Uint8Array) => {
  expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  const header = new DataView(bytes.buffer, bytes.byteOffset + 16, 8);
  return { width: header.getUint32(0), height: header.getUint32(4) };
};

const picture = async (path: string) => {
  const answered = await ask(path);
  return {
    status: answered.status,
    type: answered.headers.get("content-type"),
    cache: answered.headers.get("cache-control"),
    size: pngSize(new Uint8Array(await answered.arrayBuffer())),
  };
};

const frontPage = async () => {
  const html = await (await ask("/", { headers: { accept: "text/html" } })).text();
  const head = html.slice(0, html.indexOf("</head>"));
  return {
    meta: (key: string) =>
      head.match(new RegExp(`<meta property="${key}" content="([^"]*)"`))?.[1] ?? "",
    link: (rel: string) => head.match(new RegExp(`<link rel="${rel}"[^>]*>`))?.[0] ?? "",
  };
};

const attribute = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";

describe("the site's pictures", () => {
  it("include the card a page's head points at, of the type and size it claims", async () => {
    const { meta } = await frontPage();
    const address = new URL(meta("og:image"));

    expect(address.origin).toBe("https://agentify.ad");
    expect(await picture(address.pathname)).toMatchObject({
      status: 200,
      type: meta("og:image:type"),
      size: { width: Number(meta("og:image:width")), height: Number(meta("og:image:height")) },
    });
  });

  it("include the icon a page's head names for a phone's home screen, at the size it names", async () => {
    const link = (await frontPage()).link("apple-touch-icon");
    const [width, height] = attribute(link, "sizes").split("x").map(Number);

    expect(await picture(attribute(link, "href"))).toMatchObject({
      status: 200,
      type: attribute(link, "type"),
      size: { width, height },
    });
  });

  it("include the card for the page about selling to agents, as that page describes it", async () => {
    expect(await picture(SELL_TO_AGENTS_PICTURE.path)).toMatchObject({
      status: 200,
      type: SELL_TO_AGENTS_PICTURE.type,
      size: { width: SELL_TO_AGENTS_PICTURE.width, height: SELL_TO_AGENTS_PICTURE.height },
    });
  });

  it.each(["/opengraph-image", SELL_TO_AGENTS_PICTURE.path, "/apple-icon"])(
    "may be kept by any cache that asks again before showing it: %s",
    async (path) => {
      expect((await picture(path)).cache).toBe("public, max-age=0, must-revalidate");
    },
  );

  it("are read alone: a HEAD has the headers and no picture, and a post is refused", async () => {
    const head = await ask("/opengraph-image", { method: "HEAD" });
    const posted = await ask("/opengraph-image", { method: "POST" });

    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(await head.text()).toBe("");
    expect(posted.status).toBe(405);
  });
});

describe("a drawing", () => {
  const draw = async (text: string) => {
    const png = await drawPng(
      <div style={{ display: "flex", fontFamily: MONO_FONT, fontSize: 48 }}>{text}</div>,
      { width: 96, height: 96 },
    );
    return Buffer.from(png);
  };

  // Two characters none of the fonts has are drawn as the same empty box, so a
  // drawing that differs from that box drew the character itself.
  it("draws the same box for any character none of its fonts has, and fetches nothing for it", async () => {
    expect((await draw("漢")).equals(await draw("丁"))).toBe(true);
    expect((await draw("漢")).equals(await draw(""))).toBe(false);
  });

  it.each(["→", "↗"])("shows the arrow %s, which the brand's fonts lack", async (arrow) => {
    expect((await draw(arrow)).equals(await draw("漢"))).toBe(false);
  });
});
