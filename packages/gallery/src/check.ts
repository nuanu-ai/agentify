/**
 * `pnpm gallery:check`: every state of every surface in the page
 * `pnpm gallery` wrote, each drawn in Chromium from that page's own markup,
 * stylesheets and fonts, composed by the gallery's own `frame.js` as its
 * frames are. It fails on three things.
 *
 * At a phone's, a tablet's and a desktop's width (390, 768 and 1440 pixels),
 * something on the page reaches past the window's right edge. An element
 * counts only as far as it shows: whatever a box below the page scrolls or
 * clips (`overflow-x` other than `visible`) is measured by that box, so a wide
 * table the product scrolls inside its own box passes and the box itself must
 * fit; what a closed disclosure holds is not drawn and not measured. The
 * page's own clipping hides nothing here, since content it cuts off at the
 * window's edge is the same defect as content it lets scroll. A failure names
 * the state, the width and the outermost elements that reach past the edge.
 *
 * At any of the three, a page that draws a `footer` and fits the window ends
 * that footer more than a pixel above the window's bottom edge, leaving an
 * empty band under it. The footer measured is the one drawn lowest, and the
 * window's bottom is taken less the room the body keeps clear under its
 * content, which the consent banner holds while it asks. A failure names the
 * state, the width and the band's height. A page taller than the window is
 * not measured here, since its footer ends where its content does.
 *
 * At any of the three, axe rates a violation serious or critical. What it
 * rates moderate or minor is listed and passes.
 *
 * Animations end at once, so each page is measured as it rests. Left alone:
 * how a state looks, which the person reading the gallery judges; the widths
 * between the three; what a press, a hover or a focus would change beyond the
 * state drawn; and the left edge, which a page written left to right never
 * scrolls to.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { AxeResults, RunOptions } from "axe-core";
import { chromium, type Page } from "playwright";

const GALLERY = fileURLToPath(new URL("../dist/index.html", import.meta.url));
const FRAME = fileURLToPath(new URL("./frame.js", import.meta.url));

/** The gallery's own devices. */
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

const FAILING = new Set(["serious", "critical"]);

/** As many pages as a runner's cores draw at once without waiting on one another. */
const PAGES_AT_ONCE = 4;

/** Every animation and transition at its end, so nothing is measured mid-way. */
const AT_REST =
  "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;" +
  "transition-duration:0s!important;transition-delay:0s!important}";

interface Gallery {
  readonly surfaces: Readonly<Record<string, { lang: string; css: string }>>;
  readonly states: Readonly<Record<string, { surface: string; html: string }>>;
}

type FrameDocument = (lang: string, fonts: string, css: string, html: string) => string;

interface Overflow {
  readonly window: number;
  readonly culprits: readonly string[];
}

interface Foot {
  readonly window: number;
  readonly page: number;
  /** The window's bottom edge less the room the body keeps clear under its content. */
  readonly floor: number;
  /** Where the lowest footer ends, or `null` on a page that draws none. */
  readonly bottom: number | null;
}

interface Violation {
  readonly rule: string;
  readonly impact: string;
  readonly help: string;
  readonly where: readonly string[];
}

const galleryOf = async () => {
  let page: string;
  try {
    page = await readFile(GALLERY, "utf8");
  } catch {
    throw new Error(`There is no gallery at ${GALLERY} to check; draw it with \`pnpm gallery\`.`);
  }
  const fonts = /<style id="gallery-fonts">([\s\S]*?)<\/style>/.exec(page)?.[1];
  const data = /<script type="application\/json" id="gallery-data">([\s\S]*?)<\/script>/.exec(
    page,
  )?.[1];
  if (fonts === undefined || data === undefined) {
    throw new Error(`${GALLERY} holds no fonts or no states; draw it again with \`pnpm gallery\`.`);
  }
  const frameDocument = runInNewContext(
    `${await readFile(FRAME, "utf8")}\ngalleryFrameDocument`,
    {},
  ) as FrameDocument;
  return { fonts, gallery: JSON.parse(data) as Gallery, frameDocument };
};

/**
 * Runs in the page, as source: it names none of its own helpers, since the
 * compiler that runs this file wraps a named function in a helper the page
 * does not have. An element's visible right edge is its own, cut by every box
 * between it and the page that does not let what is wider show; the outermost
 * elements whose visible edge passes the window are named.
 */
function overflowOf(): Overflow {
  const page = document.documentElement;
  const window = page.clientWidth;
  const showsOverflow = new Map<Element, boolean>();
  const past: Element[] = [];
  for (const element of document.body.querySelectorAll("*")) {
    const drawn = element.getBoundingClientRect();
    if (drawn.width === 0 || drawn.height === 0) continue;
    // A closed disclosure keeps a box for what it holds and shows none of it.
    if (element.closest("details:not([open]) > :not(summary)") !== null) continue;
    let right = drawn.right;
    for (
      let box = element.parentElement;
      box !== null && box !== document.body && box !== page;
      box = box.parentElement
    ) {
      let shows = showsOverflow.get(box);
      if (shows === undefined) {
        shows = getComputedStyle(box).overflowX === "visible";
        showsOverflow.set(box, shows);
      }
      if (!shows) right = Math.min(right, box.getBoundingClientRect().right);
    }
    if (right > window + 1) past.push(element);
  }
  return {
    window,
    culprits: past
      .filter((element) => element.parentElement === null || !past.includes(element.parentElement))
      .slice(0, 3)
      .map((element) => {
        const classes = [...element.classList]
          .slice(0, 2)
          .map((name) => `.${name}`)
          .join("");
        const id = element.id === "" ? "" : `#${element.id}`;
        const words = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        const right = Math.round(element.getBoundingClientRect().right);
        return `${element.tagName.toLowerCase()}${id}${classes}${words === "" ? "" : ` "${words}"`} to ${right} px`;
      }),
  };
}

/** Runs in the page, as source, under the same constraint as `overflowOf`. */
function footOf(): Foot {
  const height = document.documentElement.clientHeight;
  let bottom: number | null = null;
  for (const footer of document.querySelectorAll("footer")) {
    const drawn = footer.getBoundingClientRect();
    if (drawn.height === 0) continue;
    bottom = bottom === null ? drawn.bottom : Math.max(bottom, drawn.bottom);
  }
  return {
    window: height,
    page: document.documentElement.scrollHeight,
    floor: height - Number.parseFloat(getComputedStyle(document.body).paddingBottom),
    bottom,
  };
}

const drawnAt = async (page: Page, document: string, width: number, height: number) => {
  await page.setViewportSize({ width, height });
  await page.setContent(document, { waitUntil: "load" });
  await page.addStyleTag({ content: AT_REST });
  await page.evaluate(async () => {
    await window.document.fonts.ready;
  });
};

const axeOn = async (page: Page, axe: string): Promise<Violation[]> => {
  await page.addScriptTag({ content: axe });
  return await page.evaluate(async () => {
    const { violations } = await (
      window as unknown as {
        axe: { run: (on: Document, options: RunOptions) => Promise<AxeResults> };
      }
    ).axe.run(window.document, { resultTypes: ["violations"] });
    return violations.map((violation) => ({
      rule: violation.id,
      impact: violation.impact ?? "minor",
      help: violation.help,
      where: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")),
    }));
  });
};

const started = Date.now();
const { fonts, gallery, frameDocument } = await galleryOf();
const axe = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const work = Object.entries(gallery.states).flatMap(([id, state]) => {
  const surface = gallery.surfaces[state.surface];
  if (surface === undefined) throw new Error(`The state ${id} names no surface the gallery holds.`);
  const document = frameDocument(surface.lang, fonts, surface.css, state.html);
  return WIDTHS.map((device) => ({ id, document, ...device }));
});

const overflows: string[] = [];
const bands: string[] = [];
/** A violation once per state, with every width it was found at. */
const violations = new Map<string, { widths: number[]; where: readonly string[] }>();
const notices = new Map<string, Set<string>>();
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const next = work[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: PAGES_AT_ONCE }, async () => {
      const page = await context.newPage();
      for (let task = next.next(); !task.done; task = next.next()) {
        const { id, document, width, height } = task.value;
        await drawnAt(page, document, width, height);
        const overflow = await page.evaluate(overflowOf);
        if (overflow.culprits.length > 0) {
          overflows.push(
            `${id} at ${width} px reaches past the window's ${overflow.window} px: ${overflow.culprits.join("; ")}`,
          );
        }
        const foot = await page.evaluate(footOf);
        if (foot.bottom !== null && foot.page <= foot.window && foot.floor - foot.bottom > 1) {
          bands.push(
            `${id} at ${width} px ends its footer ${Math.round(foot.floor - foot.bottom)} px above the bottom of the ${foot.window} px window it fits in`,
          );
        }
        for (const violation of await axeOn(page, axe)) {
          const said = `${violation.rule} (${violation.impact}): ${violation.help}`;
          if (!FAILING.has(violation.impact)) {
            notices.set(said, (notices.get(said) ?? new Set()).add(id));
            continue;
          }
          const found = violations.get(`${id} ${said}`);
          if (found === undefined) {
            violations.set(`${id} ${said}`, { widths: [width], where: violation.where });
          } else {
            found.widths.push(width);
          }
        }
      }
    }),
  );
} finally {
  await browser.close();
}

const failures = [
  ...overflows,
  ...bands,
  ...[...violations].map(([key, { widths, where }]) => {
    const [id = "", ...said] = key.split(" ");
    const at = widths.sort((one, other) => one - other).join(", ");
    return `${id} at ${at} px, axe ${said.join(" ")}, at ${where.join(", ")}`;
  }),
].sort();
for (const [said, ids] of notices) {
  const listed = [...ids];
  console.log(
    `Passing, rated below serious: ${said}, on ${listed.length} state${listed.length === 1 ? "" : "s"}: ${listed.slice(0, 8).join(", ")}${listed.length > 8 ? ", …" : ""}`,
  );
}
for (const failure of failures) console.error(failure);
console.log(
  `${Object.keys(gallery.states).length} states at ${WIDTHS.map((device) => device.width).join(", ")} px:` +
    ` ${failures.length === 0 ? "nothing failed" : `${failures.length} failing`}, in ${Math.round((Date.now() - started) / 1000)} s.`,
);
if (failures.length > 0) process.exitCode = 1;
