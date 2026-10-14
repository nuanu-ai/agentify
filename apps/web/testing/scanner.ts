/**
 * The scanner as a test asks it, over HTTP: the whole process compiled from
 * source by Vite in middleware mode, once per test file, on an ephemeral
 * loopback port. Nothing is built and nothing is watched, and the workspace's
 * packages are read from their source rather than their build, so `pnpm test`
 * runs the source as it stands with no build step. What it writes to disk is
 * Vite's prebundled dependencies, in a temporary folder of this file's own
 * that is removed once its tests end, and the route types React Router
 * rewrites under `.react-router` whenever a server starts.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll } from "vitest";
import { scannerSourceAlias } from "../../../vitest.config";
import { type FromSource, scannerFromSource } from "../server/from-source";

export interface Scanner {
  /** Where the scanner answers, as `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** A module of the scanner as the running process sees it. */
  load<Module>(path: string): Promise<Module>;
}

let started: Promise<Readonly<{ scanner: Scanner; close: () => Promise<void> }>> | undefined;

const start = async () => {
  const source: FromSource = await scannerFromSource({ live: false, alias: scannerSourceAlias });
  const server = createServer(source.listener).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    scanner: { origin: `http://127.0.0.1:${port}`, load: source.load },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await source.close();
    },
  };
};

export const testScanner = async (): Promise<Scanner> => {
  started ??= start();
  return (await started).scanner;
};

/** One request to the scanner, never following a redirect, so a test sees the answer itself. */
export const ask = async (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${(await testScanner()).origin}${path}`, { redirect: "manual", ...init });

afterAll(async () => {
  await (await started)?.close();
});
