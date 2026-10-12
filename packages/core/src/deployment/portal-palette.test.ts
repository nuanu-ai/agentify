/**
 * `packages/visual/tokens.css` is the visual language, and every surface reads
 * it except the portal: a separate project with its own build, whose theme
 * writes the colours out again as `--agentify-*`. If this fails, the
 * documentation renders in colours the rest of the origin no longer uses.
 *
 * Only the light declarations are compared, because the language has only a
 * light set. The files are parsed rather than spelled out here, so a colour the
 * portal starts copying is compared from the day it appears.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

/**
 * The declarations of the first `:root { … }` block, which is the light set in
 * both files. The selector is anchored so that `:root[data-theme="dark"]` and
 * `:root:not(…)` cannot answer for it.
 */
const rootDeclarations = (stylesheet: string, whose: string): Map<string, string> => {
  const body = /^:root\s*\{([^}]*)\}/m.exec(stylesheet)?.[1];
  if (body === undefined) throw new Error(`${whose} has no :root block to read`);
  const declarations = new Map<string, string>();
  for (const [, name = "", value = ""] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(name, value.trim());
  }
  return declarations;
};

const SHARED = rootDeclarations(read("../../../visual/tokens.css"), "packages/visual/tokens.css");
const PORTAL = rootDeclarations(
  read("../../../../apps/docs/.vitepress/theme/agentify.css"),
  "the portal theme",
);

/** What the portal calls `--agentify-bg`, the shared file calls `--bg`. */
const copied = [...PORTAL.entries()]
  .filter(([name]) => name.startsWith("--agentify-"))
  .map(([name, value]) => ({ name, shared: name.replace("--agentify-", "--"), value }));

describe("the portal's copy of the palette", () => {
  it("copies something at all", () => {
    // Without this, a parse that found nothing would make every assertion
    // below pass by having no cases to run.
    expect(copied.length).toBeGreaterThan(0);
    expect(SHARED.size).toBeGreaterThan(0);
  });

  // An absent counterpart fails here too: a token deleted from the shared file
  // leaves the portal painting with a value nothing else on the origin has.
  it.each(copied)("$name is the shared $shared", ({ shared, value }) => {
    expect(SHARED.get(shared)).toBe(value);
  });
});
