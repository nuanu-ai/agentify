import type { SurfaceSource } from "./draw.js";

/**
 * Every surface whose states the gallery draws, in the order the page lists
 * them. A surface joins with a module exporting `gallery` (a `GallerySurface`)
 * and a line here.
 */
export const SURFACES: readonly SurfaceSource[] = [];
