/**
 * The speed budget of a React Router build, checked against the build itself:
 * a page fails when the script it loads on its first visit, compressed with
 * brotli as it is sent, grows past the limit, and the build fails when a file
 * it wrote for the browser lacks the content hash in its name or is served
 * without the year-long immutable cache the hash makes safe. Each file is
 * fetched from where the application serves it, so the header checked is the
 * one a browser gets.
 *
 * A page's first visit counts what it loads before any script runs: React
 * Router's entry, the modules of every route from the root to the page with
 * what they import, and the route table's file where the page asks for it.
 * Under lazy route discovery, React Router's default for a server-drawn
 * build, it does not: the page's HTML carries the part of the table it needs,
 * and the rest is asked for route by route as links appear. What a page can
 * load later, through an `import()` that waits for a consent, a step or a
 * click, is printed beside it and not counted, so a heavy library moved
 * behind one stays in sight.
 * Neither counts the stylesheets, and a route that answers with data or a
 * file rather than a page loads nothing and is left out.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ServerBuild } from "react-router";

const HASHED = /-[\w-]{8}\.(?:js|css)$/;

const IMMUTABLE = "public, max-age=31536000, immutable";

/** One chunk as Vite's manifest describes it. */
interface Chunk {
  readonly file: string;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
}

export interface Budget {
  /** Prefixes every line printed, as `[dashboard]`. */
  readonly label: string;
  readonly build: ServerBuild;
  /** Where the client build was written, the directory holding `assets/`. */
  readonly clientDirectory: string;
  /** The address the application serves `assets/` at, for the header check. */
  readonly assetsAt: string;
  /** Bytes of brotli-compressed script a page may load on its first visit. */
  readonly limit: number;
  /** A page sent with no script at all, which loads none and is left out. */
  readonly scriptless?: (routeId: string) => boolean;
}

/**
 * Prints each page's first-visit script, heaviest first, with what it can load
 * later, and returns what broke the budget; an empty list is a kept budget.
 * Vite's manifest must have been kept (`build.manifest: true`), since it is
 * the one record of which chunk imports which later.
 */
export async function brokenBudget(budget: Budget): Promise<readonly string[]> {
  const { build, clientDirectory, limit, label } = budget;
  const assets = join(clientDirectory, "assets");
  const failures: string[] = [];
  const manifest = JSON.parse(
    await readFile(join(clientDirectory, ".vite", "manifest.json"), "utf8"),
  ) as Record<string, Chunk>;
  const byFile = new Map(Object.values(manifest).map((chunk) => [chunk.file, chunk]));
  const fileOf = (url: string): string => `assets/${url.slice(url.lastIndexOf("/") + 1)}`;
  const brotliSize = async (file: string): Promise<number> =>
    (await stat(join(clientDirectory, `${file}.br`))).size;
  const sizeOf = async (files: ReadonlySet<string>): Promise<number> =>
    (await Promise.all([...files].map(brotliSize))).reduce((sum, size) => sum + size, 0);

  /** Every chunk `files` import, statically or, where `later` says so, by `import()`. */
  const reached = (files: Iterable<string>, later: boolean): Set<string> => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const chunk = byFile.get(file);
      for (const key of [
        ...(chunk?.imports ?? []),
        ...(later ? (chunk?.dynamicImports ?? []) : []),
      ]) {
        const imported = manifest[key];
        if (imported?.file.endsWith(".js")) visit(imported.file);
      }
    };
    for (const file of files) visit(file);
    return seen;
  };

  const firstVisit = (leafId: string): Set<string> => {
    const tableInline = build.routeDiscovery.mode === "lazy" && build.ssr;
    const urls = [
      ...(tableInline ? [] : [build.assets.url]),
      build.assets.entry.module,
      ...build.assets.entry.imports,
    ];
    for (let id: string | undefined = leafId; id !== undefined; id = build.routes[id]?.parentId) {
      const route = build.assets.routes[id];
      if (route === undefined) continue;
      urls.push(route.module, ...(route.imports ?? []));
    }
    return reached(urls.map(fileOf), false);
  };

  // A page is an address that draws something, as React Router decides it: a
  // route without a component or an error boundary of its own answers with
  // data or a file, and a layout without a path is never visited alone.
  const pages = Object.keys(build.routes).filter((id) => {
    const route = build.routes[id];
    const module = route?.module as { default?: unknown; ErrorBoundary?: unknown } | undefined;
    const addressed = route?.index === true || (route?.path ?? "") !== "";
    const draws = module?.default !== undefined || module?.ErrorBoundary !== undefined;
    return addressed && draws && !(budget.scriptless?.(id) ?? false);
  });
  const measured = await Promise.all(
    pages.map(async (id) => {
      const first = firstVisit(id);
      const later = new Set([...reached(first, true)].filter((file) => !first.has(file)));
      return { id, first: await sizeOf(first), later: await sizeOf(later) };
    }),
  );
  measured.sort((a, b) => b.first - a.first);
  const kb = (bytes: number): string => (bytes / 1024).toFixed(1).padStart(6);
  for (const { id, first, later } of measured) {
    const over = first > limit;
    const afterwards = later > 0 ? `   later up to ${kb(later).trim()} KB more` : "";
    console.log(`${label} ${over ? "OVER " : "     "}${kb(first)} KB  ${id}${afterwards}`);
    if (over)
      failures.push(`${id} loads ${first} bytes of script on its first visit, over ${limit}`);
  }

  const written = (await readdir(assets)).filter((name) => /\.(?:js|css)$/.test(name));
  for (const name of written) {
    if (!HASHED.test(name)) failures.push(`${name} carries no content hash in its name`);
    const answered = await fetch(`${budget.assetsAt}/${name}`, {
      headers: { "accept-encoding": "br" },
    });
    await answered.arrayBuffer();
    const cache = answered.headers.get("cache-control");
    if (answered.status !== 200 || cache !== IMMUTABLE) {
      failures.push(`${name} is answered ${answered.status} with cache-control ${cache}`);
    }
  }
  if (failures.length === 0) {
    console.log(
      `${label} every page loads at most ${limit / 1024} KB of script on its first visit, and all ${written.length} files are hashed and kept for a year`,
    );
  }
  return failures;
}
