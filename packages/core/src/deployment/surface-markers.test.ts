/**
 * One sentence, two renderers.
 *
 * The cabinet imports its wording; the portal cannot, because its banner is
 * written by a build hook, so the words are spelled out in that file. This is
 * what stops the two copies drifting: the file itself is read here and held
 * against the module the cabinet reads.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "./environment.js";

const PORTAL_CONFIG = readFileSync(
  new URL("../../../../apps/docs/.vitepress/config.mjs", import.meta.url),
  "utf8",
);

describe("the portal's build hook", () => {
  it("writes the same marker into every page it builds", () => {
    expect(PORTAL_CONFIG).toContain(SURFACE_MARKER_ATTRIBUTE);
    expect(PORTAL_CONFIG).toContain(SURFACE_WORDS.test);
    expect(PORTAL_CONFIG).toContain(SURFACE_WORDS.sandbox);
  });
});
