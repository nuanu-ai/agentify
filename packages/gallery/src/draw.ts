/**
 * Draws one surface's states with that surface's own Vite, configured by its
 * own `vite.config.ts`, so its stylesheets come out as its build processes
 * them: imports inlined, CSS modules scoped under the very class names its
 * components were given. The stylesheets are taken from Vite's pipeline after
 * they are compiled and before they become modules, which is the one point
 * where a CSS module's text and its class names are known together.
 *
 * A state is drawn as the surface's server sends it, waiting for every part
 * that loads on its own, or, where it has a scene, in a document under the
 * surface's client renderer, as the page's script leaves it.
 *
 * The published page can fetch nothing, so every file the states or their
 * stylesheets point at by address (the brand mark, a font, a picture) goes
 * into the page as a data address, looked up where the origin would serve it
 * from.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AliasOptions, Plugin } from "vite";
import { type BrowserReact, drawnInBrowser } from "./browser.js";
import type { GalleryState, GallerySurface } from "./index.js";

/** Where a surface lives and the module that registers its states. */
export interface SurfaceSource {
  /** The surface's application folder, holding its `vite.config.ts`. */
  readonly root: string;
  /** The module exporting `gallery`, relative to `root`. */
  readonly module: string;
  /**
   * Where the surface's own checks point the workspace's packages at their
   * source, for a surface that otherwise loads them from their build.
   */
  readonly alias?: AliasOptions;
}

export interface DrawnState {
  readonly id: string;
  readonly screen: string;
  readonly address: string;
  readonly when: string;
  readonly cause: string;
  /** The page's body as the server sends it, with its files embedded. */
  readonly html: string;
  /** For a state its page's script reaches, the words that show it. */
  readonly shows?: string;
}

export interface DrawnSurface {
  readonly id: string;
  readonly name: string;
  readonly lang: string;
  /** Every stylesheet the states reached, compiled, in the order Vite met them. */
  readonly css: string;
  readonly states: readonly DrawnState[];
}

const STYLESHEET = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

/** A stylesheet asked for as a string or an address is the importer's to place, not the page's. */
const NOT_APPLIED = /[?&](?:inline|raw|url|worker|sharedworker)\b/;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

/** The marks and faces the origin serves at its root to every surface. */
export const SHARED_FILES = dirname(
  dirname(fileURLToPath(import.meta.resolve("@agentify/visual/public/styles/fonts.css"))),
);

/** The file a browser would get at this address, or null where no folder holds one. */
type Finder = (address: string) => string | null;

/**
 * Vite's development server writes a file's address under the surface's base:
 * `@fs/` and an absolute path for a file outside the surface, a path from the
 * surface's folder otherwise. A page writes the origin's shared files from the
 * root.
 */
export const finderIn =
  (base: string, folders: readonly string[]): Finder =>
  (address) => {
    const path = decodeURI(address.replace(/[?#].*$/, ""));
    if (path.startsWith(`${base}@fs/`)) return path.slice(`${base}@fs`.length);
    const under = path.startsWith(base) ? path.slice(base.length) : path.replace(/^\//, "");
    return folders.map((folder) => join(folder, under)).find((file) => existsSync(file)) ?? null;
  };

const dataAddresses = new Map<string, Promise<string | null>>();

/** Null for a file that is no image or font, which a page has no business embedding. */
const dataAddressOf = (file: string): Promise<string | null> => {
  const type = MEDIA_TYPES[extname(file).toLowerCase()];
  if (type === undefined) return Promise.resolve(null);
  const known = dataAddresses.get(file);
  if (known !== undefined) return known;
  const read = readFile(file).then((bytes) => `data:${type};base64,${bytes.toString("base64")}`);
  dataAddresses.set(file, read);
  return read;
};

/** Every `url()` in a stylesheet made a data address; one the page could not embed is refused. */
export async function withFilesInlined(css: string, find: Finder): Promise<string> {
  let inlined = css;
  for (const [whole, , written = ""] of css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
    if (/^(?:data:|#)/.test(written)) continue;
    const file = /^[a-z][a-z0-9+.-]*:/i.test(written) ? null : find(written);
    const embedded = file === null ? null : await dataAddressOf(file);
    if (embedded === null) {
      throw new Error(`A stylesheet points at ${written}, which the gallery's page cannot embed.`);
    }
    inlined = inlined.replace(whole, `url("${embedded}")`);
  }
  return inlined;
}

/**
 * A page's images, each width a source set offers among them, and the
 * preloads React writes for them, made data addresses. Every other address, a
 * link's among them, is left as it is.
 */
const withImagesInlined = async (html: string, find: Finder): Promise<string> => {
  const embeddedAt = async (written: string): Promise<string> => {
    const file = written.startsWith("/") ? find(written) : null;
    return (file === null ? null : await dataAddressOf(file)) ?? written;
  };
  let inlined = html;
  for (const [whole, attribute, written = ""] of html.matchAll(/\b(src|href)="(\/[^"]*)"/g)) {
    const embedded = await embeddedAt(written);
    if (embedded !== written) inlined = inlined.replaceAll(whole, `${attribute}="${embedded}"`);
  }
  for (const [whole, attribute, written = ""] of inlined.matchAll(/\b(srcset)="([^"]*)"/gi)) {
    const candidates = await Promise.all(
      written.split(/,\s+/).map(async (candidate) => {
        const [address = "", ...width] = candidate.trim().split(/\s+/);
        return [await embeddedAt(address), ...width].join(" ");
      }),
    );
    inlined = inlined.replaceAll(whole, `${attribute}="${candidates.join(", ")}"`);
  }
  return inlined;
};

/**
 * Every part that loads on its own is waited for, as a server that answers
 * with the whole page does; a part that fails is a state that cannot be drawn.
 */
const prerendered = async (
  prerender: Prerender,
  drawn: ReturnType<GalleryState["draw"]>,
): Promise<string> => {
  const failures: unknown[] = [];
  const { prelude } = await prerender(drawn, { onError: (failure) => void failures.push(failure) });
  const html = await new Response(prelude).text();
  if (failures.length > 0) throw failures[0];
  return html;
};

type Prerender = (
  drawn: ReturnType<GalleryState["draw"]>,
  options: { onError: (failure: unknown) => void },
) => Promise<{ prelude: ReadableStream<Uint8Array> }>;

/**
 * The document replaces these with its own realm's, while Vite's compiler,
 * which compiles a part of a page the first time the page loads it, passes
 * Node's own buffers to its worker and fails on any other kind. No page needs
 * the document's.
 */
const LANGUAGE_OWN = [
  "ArrayBuffer",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Uint8ClampedArray",
  "Float32Array",
  "Float64Array",
  "URL",
  "Request",
] as const;

/** Where a scene's document stands, so a page that reads its own origin reads the site's. */
const BROWSER_ORIGIN = "https://agentify.ad/";

export async function drawSurface(source: SurfaceSource): Promise<DrawnSurface> {
  const stylesheets = new Map<string, string>();
  const keepStylesheets: Plugin = {
    name: "agentify-gallery-stylesheets",
    transform(code, id) {
      if (STYLESHEET.test(id) && !NOT_APPLIED.test(id)) stylesheets.set(id, code);
      return null;
    },
  };
  // The surface's own Vite, which its configuration and plugins expect, and
  // its own React, the one its components render with.
  const fromSurface = createRequire(join(source.root, "package.json"));
  const surfaceHas = async <Module>(name: string): Promise<Module> =>
    (await import(pathToFileURL(fromSurface.resolve(name)).href)) as Module;
  const vite = await surfaceHas<typeof import("vite")>("vite");
  const { prerender } = await surfaceHas<{ prerender: Prerender }>("react-dom/static");
  const server = await vite.createServer({
    root: source.root,
    configFile: join(source.root, "vite.config.ts"),
    appType: "custom",
    logLevel: "silent",
    ...(source.alias === undefined ? {} : { resolve: { alias: source.alias } }),
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [keepStylesheets],
  });
  try {
    const { gallery } = (await server.ssrLoadModule(join(source.root, source.module))) as {
      gallery: GallerySurface;
    };
    const find = finderIn(server.config.base, [source.root, server.config.publicDir, SHARED_FILES]);
    const drawn = new Map<string, string>();
    const scenes = gallery.states.flatMap((state) =>
      state.scene === undefined ? [] : [[state, state.scene] as const],
    );
    if (scenes.length > 0) {
      // The test runner's own document, the one a surface's checks draw the
      // scenes in. The client renderer is loaded only once it stands, since it
      // reads the document as it loads.
      const { builtinEnvironments } = await import("vitest/runtime");
      const own = Object.fromEntries(
        LANGUAGE_OWN.map((name) => [name, Reflect.get(globalThis, name)]),
      );
      const browser = await builtinEnvironments.jsdom.setup(globalThis, {
        jsdom: { url: BROWSER_ORIGIN },
      });
      Object.assign(globalThis, own);
      try {
        const react: BrowserReact = {
          act: (await surfaceHas<{ act: BrowserReact["act"] }>("react")).act,
          createRoot: (await surfaceHas<Pick<BrowserReact, "createRoot">>("react-dom/client"))
            .createRoot,
        };
        for (const [state, scene] of scenes) {
          drawn.set(state.id, await drawnInBrowser(state, scene, react));
        }
      } finally {
        await browser.teardown(globalThis);
      }
    }
    // After the scenes: the server renderer marks every context it provides
    // as its own for good, and the client renderer warns about each one so
    // marked; the client renderer clears its own marks.
    for (const state of gallery.states) {
      if (state.scene !== undefined) continue;
      try {
        drawn.set(state.id, await prerendered(prerender, state.draw()));
      } catch (failure) {
        throw new Error(`The state ${state.id} could not be drawn.`, { cause: failure });
      }
    }
    const states: DrawnState[] = [];
    for (const { id, screen, address, when, cause, scene } of gallery.states) {
      const html = await withImagesInlined(drawn.get(id) ?? "", find);
      states.push({
        id,
        screen,
        address,
        when,
        cause,
        html,
        ...(scene === undefined ? {} : { shows: scene.shows }),
      });
    }
    return {
      id: gallery.id,
      name: gallery.name,
      lang: gallery.lang,
      css: await withFilesInlined([...stylesheets.values()].join("\n"), find),
      states,
    };
  } finally {
    await server.close();
  }
}
