/**
 * The gallery as one page for the host that publishes it, which wraps the
 * file in its own document and lets a page load nothing from anywhere: so no
 * document skeleton is written here, the title comes first, and the fonts,
 * each surface's stylesheet (once, however many states use it) and every
 * state's markup are inside the file. A state is shown in a frame composed in
 * the browser from those parts.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type DrawnSurface, finderIn, SHARED_FILES, withFilesInlined } from "./draw.js";

const TITLE = "Agentify Screens";

/** The host reads a page's title from its first eight kilobytes. */
const TITLE_WITHIN = 8 * 1024;

/** The largest page the host publishes. */
const PAGE_AT_MOST = 16 * 1024 * 1024;

/** An anchor that survives the host, which passes on a bare `#` and letters, digits and a few marks. */
const ANCHOR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const escaped = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Inside a script element nothing may read as markup, so every `<` is written
 * as JSON's escape for it, which reads back as the same character.
 */
const asScriptData = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c");

/** The product's two faces, from the files the origin serves, as data addresses. */
export async function productFonts(): Promise<string> {
  const css = await readFile(join(SHARED_FILES, "styles", "fonts.css"), "utf8");
  return await withFilesInlined(css, finderIn("/", [SHARED_FILES]));
}

/** Screens in the order their first state is registered, each with its states. */
const screensOf = (surface: DrawnSurface) => {
  const screens = new Map<string, DrawnSurface["states"][number][]>();
  for (const state of surface.states) {
    screens.set(state.screen, [...(screens.get(state.screen) ?? []), state]);
  }
  return [...screens.entries()];
};

/** What a frame would fetch: any source, or a linked file, that is not already in the page. */
const fetchedBy = (html: string): string[] =>
  [
    ...[...html.matchAll(/\ssrc="([^"]*)"/gi)].map(([, address = ""]) => address),
    ...[...html.matchAll(/<link\b[^>]*\shref="([^"]*)"/gi)].map(([, address = ""]) => address),
    ...[...html.matchAll(/\ssrcset="([^"]*)"/gi)].flatMap(([, candidates = ""]) =>
      candidates.split(/,\s+/).map((candidate) => candidate.trim().split(/\s+/)[0] ?? ""),
    ),
  ].filter((address) => !address.startsWith("data:"));

/**
 * Refuses what would break in the published page or in a comment about it: a
 * state named twice, a name the host would not pass on as an anchor, a state
 * that belongs to another surface, an explanation left empty, and a screen
 * that asks for a file by address, which the host blocks without a word.
 */
export function refusalsIn(surfaces: readonly DrawnSurface[]): string[] {
  const refusals: string[] = [];
  const seen = new Set<string>();
  for (const surface of surfaces) {
    if (!ANCHOR.test(surface.id))
      refusals.push(`The surface id "${surface.id}" is not a plain anchor.`);
    for (const state of surface.states) {
      if (!ANCHOR.test(state.id))
        refusals.push(`The state id "${state.id}" is not a plain anchor.`);
      if (!state.id.startsWith(`${surface.id}-`)) {
        refusals.push(`The state ${state.id} does not start with its surface's id, ${surface.id}.`);
      }
      if (seen.has(state.id)) refusals.push(`The state id ${state.id} is used twice.`);
      seen.add(state.id);
      for (const field of ["screen", "address", "when", "cause"] as const) {
        if (state[field].trim() === "")
          refusals.push(`The state ${state.id} says nothing in ${field}.`);
      }
      for (const address of fetchedBy(state.html)) {
        refusals.push(`The state ${state.id} asks for ${address}, which the page cannot fetch.`);
      }
    }
  }
  return refusals;
}

const nav = (surfaces: readonly DrawnSurface[]): string =>
  surfaces
    .map(
      (surface) =>
        `<h2>${escaped(surface.name)}</h2><ul>${screensOf(surface)
          .map(
            ([screen, states]) =>
              `<li><div class="gallery-screen-name">${escaped(screen)}<span>${states.length}</span></div><ul>${states
                .map(
                  (state) =>
                    `<li><a href="#${state.id}">${escaped(state.id.slice(surface.id.length + 1))}</a></li>`,
                )
                .join("")}</ul></li>`,
          )
          .join("")}</ul>`,
    )
    .join("");

const statesOf = (surfaces: readonly DrawnSurface[]): string =>
  surfaces
    .map(
      (surface) =>
        `<h2>${escaped(surface.name)}</h2>${screensOf(surface)
          .map(
            ([screen, states]) =>
              `<h3 class="gallery-screen">${escaped(screen)}</h3>${states
                .map(
                  (state) => `<article class="gallery-state" id="${state.id}">
<header><span class="gallery-id">${state.id}</span><span class="gallery-address">${escaped(state.address)}</span></header>
<dl><div><dt>When you see it</dt><dd>${escaped(state.when)}</dd></div><div><dt>What causes it</dt><dd>${escaped(state.cause)}</dd></div></dl>
<div class="gallery-frame" data-state="${state.id}"></div>
</article>`,
                )
                .join("\n")}`,
          )
          .join("\n")}`,
    )
    .join("\n");

export interface PageParts {
  readonly surfaces: readonly DrawnSurface[];
  /** `@font-face` rules whose files are data addresses. */
  readonly fonts: string;
  readonly css: string;
  readonly script: string;
  /** The brand mark as a data address. */
  readonly mark: string;
}

/**
 * The page, or a refusal naming what the host would not publish whole: a
 * document skeleton of its own, a title past the part read for one, or more
 * than the host takes.
 */
export function pageOf({ surfaces, fonts, css, script, mark }: PageParts): string {
  const refusals = refusalsIn(surfaces);
  if (refusals.length > 0) throw new Error(refusals.join("\n"));
  const states = surfaces.flatMap((surface) => surface.states);
  const screens = surfaces.reduce((sum, surface) => sum + screensOf(surface).length, 0);
  const data = {
    css: Object.fromEntries(surfaces.map((surface) => [surface.id, surface.css])),
    states: Object.fromEntries(
      surfaces.flatMap((surface) =>
        surface.states.map((state) => [
          state.id,
          { surface: surface.id, html: state.html, shows: state.shows ?? null },
        ]),
      ),
    ),
  };
  const page = `<title>${TITLE}</title>
<style>${css}</style>
<style id="gallery-fonts">${fonts}</style>
<div class="gallery" data-device="desktop">
<header class="gallery-bar">
<p class="gallery-name"><img src="${mark}" alt="">${TITLE}<span class="gallery-count">${states.length} states of ${screens} screens</span></p>
<button class="gallery-nav-toggle" type="button" aria-expanded="false" aria-controls="gallery-nav">Screens</button>
<div class="gallery-widths" role="group" aria-label="Width of the frames">
<button type="button" value="phone" aria-pressed="false">Phone <span>390</span></button>
<button type="button" value="tablet" aria-pressed="false">Tablet <span>768</span></button>
<button type="button" value="desktop" aria-pressed="true">Desktop <span>1440</span></button>
</div>
</header>
<div class="gallery-body">
<nav class="gallery-nav" id="gallery-nav" aria-label="Screens and their states">${nav(surfaces)}</nav>
<main class="gallery-main">
<p class="gallery-lede">Each page of the surfaces below in the states a person can meet it in, drawn by the product's own screens from example data: as the server sends it, or, for a state only the page's script reaches, as the script leaves it. Each frame is one device's screen at the width chosen above; scroll inside it for the rest of the page. Links and buttons inside the frames go nowhere. To comment on a state, name its label.</p>
${statesOf(surfaces)}
</main>
</div>
</div>
<script type="application/json" id="gallery-data">${asScriptData(data)}</script>
<script>${script}</script>
`;
  if (/<!doctype|<(?:html|head|body)[\s>]/i.test(page)) {
    throw new Error("The page holds document markup of its own; the host adds that.");
  }
  if (page.indexOf("</title>") > TITLE_WITHIN) {
    throw new Error("The title is not in the page's first 8 KB, where the host reads it.");
  }
  const size = Buffer.byteLength(page);
  if (size > PAGE_AT_MOST) {
    throw new Error(`The page is ${size} bytes, more than the ${PAGE_AT_MOST} the host publishes.`);
  }
  return page;
}
