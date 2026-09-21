/**
 * No stylesheet on the origin uses a token nothing defines.
 *
 * The visual language renamed its tokens when it moved into one file, and two
 * stylesheets merged in from another branch kept the old names: an unresolved
 * `var()` is invalid at computed-value time, so the rule falls to its initial
 * value and a divider quietly disappears. Nobody sees a stylesheet fail, which
 * is why this check is a machine and not a comment.
 *
 * Every `var(--name)` in the repository's own stylesheets must have a `--name:`
 * declared in some stylesheet of the repository, or set inline from a
 * component as `"--name":`; VitePress's own `--vp-*` tokens are the portal's
 * and are defined by its theme at run time.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".next", "coverage", ".git", ".claude"]);

function sources(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    if (SKIP.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sources(path, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) found.push(path);
  }
  return found;
}

const roots = [join(ROOT, "apps"), join(ROOT, "packages")];
const files = roots.flatMap((root) => sources(root, [".css"]));
const components = roots.flatMap((root) => sources(root, [".tsx", ".ts", ".html"]));
const defined = new Set<string>();
const used = new Map<string, Set<string>>();
for (const file of components) {
  for (const [, name = ""] of readFileSync(file, "utf8").matchAll(/"(--[a-zA-Z0-9-]+)"\s*:/g))
    defined.add(name);
}
for (const file of files) {
  const css = readFileSync(file, "utf8");
  for (const [, name = ""] of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(name);
  for (const [, name = ""] of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
    if (name.startsWith("--vp-")) continue;
    const where = used.get(name) ?? new Set<string>();
    where.add(file.slice(ROOT.length));
    used.set(name, where);
  }
}

describe("the tokens the stylesheets paint with", () => {
  it("finds stylesheets to check", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(defined.size).toBeGreaterThan(10);
  });

  it("are all defined somewhere on the origin", () => {
    const undefinedTokens = [...used.entries()]
      .filter(([name]) => !defined.has(name))
      .map(([name, where]) => `${name} in ${[...where].join(", ")}`);
    expect(undefinedTokens).toEqual([]);
  });
});
