/**
 * What the speed budget counts as a page's first visit: the scripts React
 * Router's document names for that page, and what they import, as the build
 * is configured. The build here is written by the test, compressed as a build
 * is, so a count is read off the limit it fits under: a page that fits a limit
 * and not one byte less weighs exactly that.
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import express from "express";
import type { ServerBuild } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { precompressedFrom } from "./assets.js";
import { brokenBudget } from "./budget.js";

/** Each script the build wrote, and how many random bytes it holds, so it compresses little. */
const SCRIPTS = {
  entry: ["entry.client-EnTrY001.js", 4_000],
  root: ["root-RoOtRo01.js", 1_000],
  home: ["home-HoMeHo01.js", 2_000],
  shared: ["shared-ShArEd01.js", 500],
  other: ["other-OtHeR001.js", 100],
  later: ["later-LaTeR001.js", 6_000],
  routeTable: ["manifest-0a1b2c3d.js", 3_000],
} as const;

type Script = keyof typeof SCRIPTS;

/** The size of each script once compressed, as the build writes it beside the script. */
const compressed = new Map<Script, number>();
const weight = (...scripts: Script[]) =>
  scripts.reduce((sum, script) => sum + (compressed.get(script) ?? Number.NaN), 0);

/** The front page's own scripts: the entry, the root, the page and what it imports. */
const PAGE: Script[] = ["entry", "root", "home", "shared"];

let client = "";
let assetsAt = "";
let close = async (): Promise<void> => {};

beforeAll(async () => {
  client = await mkdtemp(join(tmpdir(), "budget-"));
  await mkdir(join(client, "assets"));
  await mkdir(join(client, ".vite"));
  for (const [script, [name, size]] of Object.entries(SCRIPTS) as [
    Script,
    readonly [string, number],
  ][]) {
    const body = Buffer.from(`export default "${randomBytes(size).toString("base64")}";\n`);
    const brotli = brotliCompressSync(body);
    await writeFile(join(client, "assets", name), body);
    await writeFile(join(client, "assets", `${name}.br`), brotli);
    compressed.set(script, brotli.length);
  }
  const chunk = (key: Script, more: object = {}) => ({
    file: `assets/${SCRIPTS[key][0]}`,
    ...more,
  });
  await writeFile(
    join(client, ".vite", "manifest.json"),
    JSON.stringify({
      "entry.client.tsx": chunk("entry"),
      "app/root.tsx": chunk("root"),
      "app/routes/home.tsx": chunk("home", {
        imports: ["_shared.js"],
        dynamicImports: ["lib/later.ts"],
      }),
      "app/routes/other.tsx": chunk("other"),
      "_shared.js": chunk("shared"),
      "lib/later.ts": chunk("later"),
    }),
  );
  const app = express();
  app.use("/assets", await precompressedFrom(join(client, "assets")));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  assetsAt = `http://127.0.0.1:${(server.address() as AddressInfo).port}/assets`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close();
  await rm(client, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return () => vi.restoreAllMocks();
});

const at = (key: Script) => `/assets/${SCRIPTS[key][0]}`;

/** A build of a front page and one other page, with routes discovered as `mode` says. */
const built = (mode: "lazy" | "initial"): ServerBuild => {
  const page = { default: () => null };
  return {
    routes: {
      root: { id: "root", path: "", module: page },
      "routes/home": { id: "routes/home", parentId: "root", index: true, module: page },
      "routes/other": { id: "routes/other", parentId: "root", path: "other", module: page },
    },
    assets: {
      url: at("routeTable"),
      version: "test",
      entry: { module: at("entry"), imports: [] },
      routes: {
        root: { id: "root", module: at("root"), imports: [] },
        "routes/home": {
          id: "routes/home",
          parentId: "root",
          module: at("home"),
          imports: [at("shared")],
        },
        "routes/other": { id: "routes/other", parentId: "root", module: at("other"), imports: [] },
      },
    },
    routeDiscovery: { mode, manifestPath: "/__manifest" },
    ssr: true,
  } as unknown as ServerBuild;
};

const fits = async (mode: "lazy" | "initial", limit: number): Promise<boolean> => {
  const failures = await brokenBudget({
    label: "[test]",
    build: built(mode),
    clientDirectory: client,
    assetsAt,
    limitOf: () => limit,
  });
  return !failures.some((failure) => failure.startsWith("routes/home "));
};

describe("a page's first visit", () => {
  it("is its own scripts and what they import, not the route table, where routes are discovered as they are needed", async () => {
    expect(await fits("lazy", weight(...PAGE))).toBe(true);
    expect(await fits("lazy", weight(...PAGE) - 1)).toBe(false);
  });

  it("takes in the route table where every route is sent up front", async () => {
    expect(await fits("initial", weight(...PAGE, "routeTable"))).toBe(true);
    expect(await fits("initial", weight(...PAGE, "routeTable") - 1)).toBe(false);
  });
});
