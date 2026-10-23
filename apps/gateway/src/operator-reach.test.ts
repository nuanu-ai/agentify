/**
 * Who can reach the operator's reader, which reads every merchant's rows: the
 * dashboard's admin services, behind the operator flag, and the code that
 * builds them, and nothing a merchant's key or a buyer reaches. The reader is
 * handed over by construction, never found through a shared object, so a
 * module that does not import it cannot hold it. If this fails, a route a
 * merchant's key or a buyer calls may be able to read another merchant's
 * orders and money.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apps = fileURLToPath(new URL("../../", import.meta.url));

/** Every source file under a folder, tests left out: a test may build what it tests. */
const sourcesIn = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter(
      (path) => /\.tsx?$/.test(path) && !/\.(test|db-test|integration\.test)\.tsx?$/.test(path),
    )
    .map((path) => join(folder, path));

const importsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
    ([, specifier = ""]) => specifier,
  );

describe("the operator's reader", () => {
  it("is imported by no module of the gateway's but its own", () => {
    const gateway = join(apps, "gateway", "src");
    const own = (path: string) =>
      /^(ports\/operator\/|adapters\/(memory|postgres)\/operator\/|operator\.ts$)/.test(path);
    const reaching = sourcesIn(gateway).filter(
      (file) =>
        !own(relative(gateway, file)) &&
        importsOf(file).some((specifier) => /(^|\/)operator(\/|\/index)?(\.js)?$/.test(specifier)),
    );

    expect(reaching.map((file) => relative(gateway, file))).toStrictEqual([]);
  });

  it("is imported in the dashboard only by its admin services and the code that builds them", () => {
    const dashboard = join(apps, "dashboard");
    const allowed = (path: string) => /^src\/(admin\/|testing\/|server\.ts$|start\.ts$)/.test(path);
    const reaching = [...sourcesIn(join(dashboard, "src")), ...sourcesIn(join(dashboard, "app"))]
      .filter(
        (file) =>
          !allowed(relative(dashboard, file)) &&
          importsOf(file).includes("@agentify/gateway/operator"),
      )
      .map((file) => relative(dashboard, file));

    expect(reaching).toStrictEqual([]);
  });
});
