/**
 * The pictures the scanner draws: an element laid out by satori into SVG and
 * turned into a PNG by resvg, both run from WebAssembly. The renderer and the
 * fonts are imported as data, so the built process carries them inside itself
 * and nothing is read from disk or fetched while a picture is drawn. A
 * character none of the fonts has is drawn as an empty box; the last font
 * holds the arrows, which the brand's fonts lack.
 */

import ibmPlexMono400 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff?inline";
import ibmPlexMono500 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff?inline";
import ibmPlexMono600 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff?inline";
import notoSansSymbols400 from "@fontsource/noto-sans-symbols/files/noto-sans-symbols-symbols-400-normal.woff?inline";
import schibstedGrotesk600 from "@fontsource/schibsted-grotesk/files/schibsted-grotesk-latin-600-normal.woff?inline";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm?inline";
import type { ReactNode } from "react";
import satori, { type Font } from "satori";

export const HUMAN_FONT = "Schibsted Grotesk";
export const MONO_FONT = "IBM Plex Mono";

const bytesOf = (dataUrl: string): Buffer =>
  Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");

const FONTS: Font[] = [
  { name: HUMAN_FONT, data: bytesOf(schibstedGrotesk600), style: "normal", weight: 600 },
  { name: MONO_FONT, data: bytesOf(ibmPlexMono400), style: "normal", weight: 400 },
  { name: MONO_FONT, data: bytesOf(ibmPlexMono500), style: "normal", weight: 500 },
  { name: MONO_FONT, data: bytesOf(ibmPlexMono600), style: "normal", weight: 600 },
  { name: "Noto Sans Symbols", data: bytesOf(notoSansSymbols400), style: "normal", weight: 400 },
];

let started: Promise<void> | undefined;

// The renderer starts once per process and refuses a second start, which a
// module evaluated again in development asks for; it is running then. A start
// that failed otherwise is tried again by the next picture.
const resvgStarted = (): Promise<void> =>
  (started ??= initWasm(bytesOf(resvgWasm)).catch((error: unknown) => {
    if (String(error).includes("Already initialized")) return;
    started = undefined;
    throw error;
  }));

/**
 * The size `element` takes when laid out at most `width` wide with nothing
 * limiting its height, by the same layout and fonts that draw it.
 */
export async function laidOutSize(
  element: ReactNode,
  width: number,
): Promise<{ width: number; height: number }> {
  const size = { width: 0, height: 0 };
  await satori(element, {
    width,
    fonts: FONTS,
    onNodeDetected: (node) => {
      size.width = Math.max(size.width, node.left + node.width);
      size.height = Math.max(size.height, node.top + node.height);
    },
  });
  return size;
}

/** `element` drawn as a PNG of this size, in the brand's fonts. */
export async function drawPng(
  element: ReactNode,
  size: Readonly<{ width: number; height: number }>,
): Promise<Uint8Array<ArrayBuffer>> {
  await resvgStarted();
  const svg = await satori(element, { ...size, fonts: FONTS });
  // The renderer's memory is its own, outside the collector's reach, so each
  // object is freed by hand, whatever happens after it is made.
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size.width } });
  try {
    const rendered = resvg.render();
    try {
      return new Uint8Array(rendered.asPng());
    } finally {
      rendered.free();
    }
  } finally {
    resvg.free();
  }
}

/** How long a cache may keep a picture: as long as it likes, asking again before showing it. */
export const PICTURE_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/**
 * A drawn picture as an answer: a PNG a cache may keep but must ask about
 * again before showing.
 */
export const pictureAnswer = (
  png: Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
): Response =>
  new Response(png, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": PICTURE_CACHE_CONTROL,
      ...headers,
    },
  });
