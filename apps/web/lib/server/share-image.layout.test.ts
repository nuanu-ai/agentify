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
      const inked = pixelsIn(
        onGround,
        (at) =>
          0.2126 * (pixels[at] ?? 0) +
            0.7152 * (pixels[at + 1] ?? 0) +
            0.0722 * (pixels[at + 2] ?? 0) <
          180,
      );

      expect(inked).toBe(0);
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

  describe("for a host too long for the card", () => {
    const changedAt = (index: number) => `${LONGEST.slice(0, index)}v${LONGEST.slice(index + 1)}`;

    it("shows where the host starts and how it ends, the site's own name", async () => {
      const longest = await picture(LONGEST, "readable", 41);

      expect(differing(longest, await picture(changedAt(0), "readable", 41))).not.toBe(0);
      expect(
        differing(longest, await picture(changedAt(LONGEST.length - 1), "readable", 41)),
      ).not.toBe(0);
    });

    it("leaves out the middle of the host", async () => {
      const longest = await picture(LONGEST, "readable", 41);
      const middle = Math.floor(LONGEST.length / 2);

      expect(differing(longest, await picture(changedAt(middle), "readable", 41))).toBe(0);
    });
  });
});
