/**
 * The documentation's diagrams, drawn once by `pnpm --filter @agentify/docs
 * diagrams` and kept beside the Markdown in `diagrams/`, each under a key
 * made of its source, the version of Mermaid that draws it and the face it is
 * measured in, the font file's bytes included, so a drawing measured in an
 * older face is drawn again. The build reads a page's drawing by that key and refuses a
 * diagram with none, so a changed diagram cannot ship with yesterday's
 * picture, and neither the build nor a reader's browser runs Mermaid.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { APP } from "./where.server.js";

export const DIAGRAMS = join(APP, "diagrams");

const required = createRequire(join(APP, "package.json"));

const MERMAID_VERSION = (required("mermaid/package.json") as { version: string }).version;

/**
 * The file the site's stylesheet serves Latin text from at every weight, which
 * is the one a label is drawn in on the page: a label measured in another
 * file, or in a bold the browser made up, runs out of its box.
 */
export const DIAGRAM_FACE = required.resolve(
  "@agentify/visual/public/styles/fonts/schibsted-grotesk-latin-wght-normal.woff2",
);

const FACE_DIGEST = createHash("sha256").update(readFileSync(DIAGRAM_FACE)).digest("hex");

/** The face a label is measured in when it is drawn, which must be the face it is shown in. */
export const DIAGRAM_FAMILY = '"Schibsted Grotesk", system-ui, sans-serif';

/**
 * Room, in pixels on each side, a label is measured with beyond its own text.
 * Linux draws the same face a pixel or two wider than the Mac a drawing is
 * usually made on, and a label drawn to its exact width there runs out of its box.
 */
export const LABEL_ROOM_PX = 3;

/** The key a diagram is kept under, which is also its element's id on the page. */
export const diagramKey = (source: string): string =>
  `diagram-${createHash("sha256")
    .update(`${MERMAID_VERSION}\n${DIAGRAM_FAMILY}\n${FACE_DIGEST}\n${LABEL_ROOM_PX}\n${source}`)
    .digest("hex")
    .slice(0, 16)}`;

/** The kept drawing of a diagram, or a refusal that says how to draw it. */
export function drawingOf(source: string): string {
  const key = diagramKey(source);
  try {
    return readFileSync(join(DIAGRAMS, `${key}.svg`), "utf8");
  } catch {
    throw new Error(
      `a mermaid diagram has no drawing (${key}.svg); draw it with \`pnpm --filter @agentify/docs diagrams\` and commit what it writes`,
    );
  }
}
