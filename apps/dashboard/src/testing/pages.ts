/**
 * The React pages as a test draws them: compiled from source by Vite in
 * middleware mode, once per test file, with nothing written to disk, nothing
 * watched and nothing fetched from the network, so `pnpm test` needs no build
 * step and always runs the source as it stands.
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
