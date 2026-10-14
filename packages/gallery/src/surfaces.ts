import { fileURLToPath } from "node:url";
import { scannerSourceAlias } from "../../../vitest.config.js";
import type { SurfaceSource } from "./draw.js";

const app = (name: string): string =>
  fileURLToPath(new URL(`../../../apps/${name}`, import.meta.url));

/**
 * Every surface whose states the gallery draws, in the order the page lists
 * them. A surface joins with a module exporting `gallery` (a `GallerySurface`)
 * and a line here.
 */
export const SURFACES: readonly SurfaceSource[] = [
  { root: app("web"), module: "app/gallery.tsx", alias: scannerSourceAlias },
  { root: app("dashboard"), module: "app/gallery.tsx" },
  { root: app("docs"), module: "app/gallery.tsx" },
];
