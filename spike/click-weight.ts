/**
 * Spike only. M1 of docs/research/48-merchant-wallet-onboarding.md: for each
 * probe module the settings page loads by `import()`, the brotli-compressed
 * bytes of every script the click loads that the page's first visit has not,
 * read from Vite's manifest the way `@agentify/ui/budget` reads it, and the
 * hosts the loaded code names, as a first list for a Content-Security-Policy.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { firstVisitScripts, type ViteManifest } from "../packages/ui/src/budget.js";
import type { ServerBuild } from "react-router";
import { builtPages } from "../apps/dashboard/src/pages.js";

const client = fileURLToPath(new URL("../apps/dashboard/dist/client", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(client, ".vite", "manifest.json"), "utf8"),
) as ViteManifest;
const build = (await builtPages()).build as ServerBuild;
const first = firstVisitScripts(build, manifest, "routes/settings");

const byFile = new Map(Object.values(manifest).map((chunk) => [chunk.file, chunk]));
const loadedBy = (file: string, later = true): Set<string> => {
  const seen = new Set<string>();
  const visit = (at: string): void => {
    if (seen.has(at)) return;
    seen.add(at);
    const chunk = byFile.get(at);
    for (const key of [...(chunk?.imports ?? []), ...(later ? (chunk?.dynamicImports ?? []) : [])]) {
      const imported = manifest[key];
      if (imported?.file.endsWith(".js")) visit(imported.file);
    }
  };
  visit(file);
  return seen;
};

const brotli = async (file: string): Promise<number> => (await stat(join(client, `${file}.br`))).size;
const raw = async (file: string): Promise<number> => (await stat(join(client, file))).size;
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

console.log(`settings, first visit: ${kb((await Promise.all([...first].map(brotli))).reduce((a, b) => a + b, 0))}`);
const targets = [...first].flatMap((file) => byFile.get(file)?.dynamicImports ?? []);
const reachedByClick = new Set<string>();
for (const key of targets) {
  const target = manifest[key];
  if (target !== undefined) for (const file of loadedBy(target.file)) reachedByClick.add(file);
}
const files = [...reachedByClick].filter((file) => !first.has(file));
const atOnce = new Set<string>();
for (const key of targets) {
  const target = manifest[key];
  if (target !== undefined) for (const file of loadedBy(target.file, false)) atOnce.add(file);
}
const atOnceFiles = [...atOnce].filter((file) => !first.has(file));
const atOnceBytes = (await Promise.all(atOnceFiles.map(brotli))).reduce((a, b) => a + b, 0);
console.log(`M1, at once: the click itself loads ${atOnceFiles.length} scripts, ${kb(atOnceBytes)} brotli; the rest below is loaded later only if the code asks for it`);
const sizes = await Promise.all(files.map(async (file) => [file, await brotli(file), await raw(file)] as const));
const total = sizes.reduce((sum, [, size]) => sum + size, 0);
const rawTotal = sizes.reduce((sum, [, , size]) => sum + size, 0);
const styles = new Set(
  files.flatMap((file) => (byFile.get(file) as { css?: readonly string[] } | undefined)?.css ?? []),
);
const styleBytes = (await Promise.all([...styles].map(brotli))).reduce((a, b) => a + b, 0);
console.log(`M1, at most: the click can load ${files.length} scripts, ${kb(total)} brotli, ${kb(rawTotal)} uncompressed; and ${styles.size} stylesheets, ${kb(styleBytes)} brotli`);
for (const [file, size, rawSize] of sizes.sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kb(size).padStart(9)}  ${kb(rawSize).padStart(9)}  ${file}`);
}
const hosts = new Set<string>();
for (const file of files) {
  for (const match of (await readFile(join(client, file), "utf8")).matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    hosts.add(match[1]?.toLowerCase() ?? "");
  }
}
console.log(`  hosts named in that code: ${[...hosts].sort().join(", ")}`);
