/**
 * The React pages as a test draws them: compiled from source by Vite in
 * middleware mode, once per test file, with nothing watched and nothing
 * fetched from the network, so `pnpm test` needs no build step and always runs
 * the source as it stands. What it writes to disk is Vite's prebundled
 * dependencies, in a temporary folder of this file's own that is removed once
 * its tests end, and the route types React Router rewrites under
 * `.react-router` whenever a server starts.
 */

import { afterAll } from "vitest";
import { type Pages, pagesFromSource } from "../pages.js";

let compiled: Promise<Pages> | undefined;

export const testPages = (): Promise<Pages> => {
  compiled ??= pagesFromSource({ live: false });
  return compiled;
};

afterAll(async () => {
  await (await compiled)?.close();
});
