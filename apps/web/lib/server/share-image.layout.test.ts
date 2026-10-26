/**
 * Only the headline of a share's picture depends on the site, because it
 * names the host. The header, the score ring, the scale and the disclaimer
 * must be drawn whole and in the same place for any host, so each picture is
 * compared pixel by pixel with the one drawn for a short host at the same
 * level. Hosts are written as the scanner records them: in lower case, a name
 * in another script in its ASCII form, up to 253 characters with labels of up
 * to 63. The widest letter such a host can repeat is "w".
 */

import type { PublicShareSnapshot } from "@agentify/scanner-contracts";
import { Resvg } from "@resvg/resvg-wasm";
import { describe, expect, it } from "vitest";

import { drawShareImage } from "./share-image";

const WIDTH = 1200;
const HEIGHT = 630;

/** Below the header, above the scale, left of the score ring. */
const HEADLINE_PLACE = { top: 126, bottom: 420, right: 840 } as const;

/** The strip of ground around the card. */
const GROUND = 30;

/** The card's top edge, above its header, where the tint of the level's colour lies. */
const TINTED_EDGE = { left: 600, right: 1120, top: 44, bottom: 78 } as const;

/** Where the tint is at its full colour. */
const TINT_CENTRE = { x: 1028, y: 59 } as const;

/** Each level's tint, by the colour of its tone. */
const TINTS: Record<PublicShareSnapshot["level"], readonly [number, number, number]> = {
  invisible: [0xf7, 0xe9, 0xe4],
  readable: [0xf3, 0xec, 0xd9],
  callable_ready: [0xe6, 0xf0, 0xef],
  ahead_of_market: [0xe7, 0xf1, 0xea],
  incomplete: [0xe6, 0xf0, 0xef],
};

/**
 * The score ring's centre and the radius of the clear space inside its
 * stroke. The score is drawn well within it, so a rim just inside the stroke
 * holds no ink.
 */
const RING = { x: 979, y: 278, clearRadius: 98, rim: 8 } as const;

const label = (length = 63) => "w".repeat(length);

const LONGEST = `${label()}.${label()}.${label()}.${label(61)}`;

const HOSTS: Record<string, string> = {
  "a 42-character host": "shop.northern-lights-outdoor-equipment.com",
  "a host with a 63-character label and no hyphen": `${label()}.com`,
  "an 86-character host":
    "very-long-subdomain-label-that-is-still-valid-under-dns-rules.example-store-shop.co.uk",
  "a punycode host": "xn--80aswg.xn--p1ai",
  "a long punycode host": `xn--${label(59)}.xn--${label(59)}.xn--p1ai`,
  "a 253-character host": LONGEST,
};

const LEVELS: readonly [PublicShareSnapshot["level"], number][] = [
  ["invisible", 12],
  ["readable", 41],
  ["callable_ready", 61],
  ["ahead_of_market", 80],
  ["incomplete", 30],
];

/** The picture's pixels as RGBA, read back by the renderer that drew it. */
const pixelsOf = (png: Uint8Array): Uint8Array => {
  const image = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  const resvg = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><image width="${WIDTH}" height="${HEIGHT}" href="${image}"/></svg>`,
  );
  try {
    const rendered = resvg.render();
    try {
      return new Uint8Array(rendered.pixels);
    } finally {
      rendered.free();
    }
  } finally {
    resvg.free();
  }
};

const drawn = new Map<string, Promise<Uint8Array>>();

const picture = (host: string, level: PublicShareSnapshot["level"], score: number) => {
  const key = `${host} ${level} ${score}`;
  const known = drawn.get(key);
  if (known) return known;
  const fresh = drawShareImage({
    host,
    score,
    level,
    rubric_version: "gtm-v1.0.0",
    generated_at: "2026-10-24T12:00:00.000Z",
  }).then(pixelsOf);
  drawn.set(key, fresh);
  return fresh;
};

type Region = (x: number, y: number) => boolean;

const everywhere: Region = () => true;

const outsideHeadline: Region = (x, y) =>
  !(x < HEADLINE_PLACE.right && y >= HEADLINE_PLACE.top && y < HEADLINE_PLACE.bottom);

const onGround: Region = (x, y) =>
  x < GROUND || x >= WIDTH - GROUND || y < GROUND || y >= HEIGHT - GROUND;

const pixelsIn = (region: Region, matching: (at: number) => boolean): number => {
  let count = 0;
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) if (region(x, y) && matching((y * WIDTH + x) * 4)) count++;
  return count;
};

const tintedEdge: Region = (x, y) =>
  x >= TINTED_EDGE.left && x < TINTED_EDGE.right && y >= TINTED_EDGE.top && y < TINTED_EDGE.bottom;

const luminance = (pixels: Uint8Array, at: number): number =>
  0.2126 * (pixels[at] ?? 0) + 0.7152 * (pixels[at + 1] ?? 0) + 0.0722 * (pixels[at + 2] ?? 0);

const ringRim: Region = (x, y) => {
  const radius = Math.hypot(x - RING.x, y - RING.y);
  return radius >= RING.clearRadius - RING.rim && radius < RING.clearRadius - 2;
};

const differing = (a: Uint8Array, b: Uint8Array, region: Region = everywhere): number =>
  pixelsIn(
    region,
    (at) =>
      a[at] !== b[at] ||
      a[at + 1] !== b[at + 1] ||
      a[at + 2] !== b[at + 2] ||
      a[at + 3] !== b[at + 3],
  );

describe("a share's picture", () => {
  describe.each(LEVELS)("at the %s level", (level, score) => {
    it("is drawn inside its card, with nothing on the ground around it", async () => {
      const pixels = await picture("example.com", level, score);
      // Text is far darker than the ground and the card's shadow on it.
      const inked = pixelsIn(onGround, (at) => luminance(pixels, at) < 180);

      expect(inked).toBe(0);
    });

    it("tints the card's top edge with the level's colour and greys none of it", async () => {
      const pixels = await picture("example.com", level, score);
      const centre = (TINT_CENTRE.y * WIDTH + TINT_CENTRE.x) * 4;
      // Every level's tint is lighter than this; grey is darker.
      const greyed = pixelsIn(tintedEdge, (at) => luminance(pixels, at) < 230);

      TINTS[level].forEach((channel, index) => {
        expect(Math.abs((pixels[centre + index] ?? 0) - channel)).toBeLessThanOrEqual(2);
      });
      expect(greyed).toBe(0);
    });

    it.each(Object.entries(HOSTS))(
      "for %s, changes nothing but the headline: the header, the score ring, the scale and the disclaimer are drawn as for a short host",
      async (_name, host) => {
        const short = await picture("example.com", level, score);
        const long = await picture(host, level, score);

        expect(differing(short, long, outsideHeadline)).toBe(0);
      },
    );
  });

  it.each([0, 9, 10, 72, 99, 100])(
    "draws a score of %i inside its ring, clear of the stroke",
    async (score) => {
      const pixels = await picture("example.com", "ahead_of_market", score);
      // The rim is white or the level's light tint; the score's figures are dark.
      const inked = pixelsIn(ringRim, (at) => luminance(pixels, at) < 200);

      expect(inked).toBe(0);
    },
  );

  describe("for a host too long for the card", () => {
    const changedAt = (index: number) => `${LONGEST.slice(0, index)}v${LONGEST.slice(index + 1)}`;

    it("shows where the host starts and how it ends, the site's own name", async () => {
      const longest = await picture(LONGEST, "readable", 41);

      expect(differing(longest, await picture(changedAt(0), "readable", 41))).not.toBe(0);
      expect(
        differing(longest, await picture(changedAt(LONGEST.length - 1), "readable", 41)),
      ).not.toBe(0);
    });

    it("keeps the site's own name whole when the start can give way to it", async () => {
      const site = "northern-lights-outdoor-equipment-and-camping";
      const host = (start: string, name: string) => `${start}.${label()}.${label()}.${name}.co.uk`;
      const drawn = await picture(host("shop", site), "readable", 41);

      expect(
        differing(drawn, await picture(host("shop", `m${site.slice(1)}`), "readable", 41)),
      ).not.toBe(0);
      expect(differing(drawn, await picture(host("chop", site), "readable", 41))).not.toBe(0);
    });

    it("shows a label at its end whole or not at all, never only its end", async () => {
      const pad = `${label()}.${label()}.${label(55)}`;
      const name = "x-customer-accounts-and-orders-help-desk-support-team-amazon";
      const host = (changed: string) => `${pad}.${changed}.com`;
      const drawn = await picture(host(name), "readable", 41);
      const startShown = differing(drawn, await picture(host(`y${name.slice(1)}`), "readable", 41));
      const endShown = differing(
        drawn,
        await picture(host(`${name.slice(0, -1)}m`), "readable", 41),
      );

      expect(startShown !== 0).toBe(endShown !== 0);
    });

    it("keeps a second www. that is part of the host's name", async () => {
      const rest = `${label()}.${label()}.${label(55)}.example.com`;
      const twice = await picture(`www.www.${rest}`, "readable", 41);
      const once = await picture(`www.${rest}`, "readable", 41);

      expect(differing(twice, once)).not.toBe(0);
    });

    it("leaves out the middle of the host", async () => {
      const longest = await picture(LONGEST, "readable", 41);
      const middle = Math.floor(LONGEST.length / 2);

      expect(differing(longest, await picture(changedAt(middle), "readable", 41))).toBe(0);
    });
  });
});
