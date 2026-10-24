/**
 * Who can reach the operator's reader, which reads every merchant's rows: the
 * dashboard's admin services, behind the operator flag, and the code that
 * builds them, and nothing a merchant's key or a buyer reaches. The reader is
 * handed over by construction, never found through a shared object, so a
 * module that does not import it cannot hold it. The payout listing, built
 * from every merchant's splits, is held to the same reach, and the contracts
 * the adapters are tested against count as their own. If this fails, a route a
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
  it("is imported by no module of the gateway's but its own, nor is the payout built from every merchant's splits", () => {
    const gateway = join(apps, "gateway", "src");
    const own = (path: string) =>
      /^(ports\/operator\/|adapters\/(memory|postgres)\/operator\/|operator\.ts$|payout-listing\.ts$|testing\/operator-[a-z]+-contract\.ts$)/.test(
        path,
      );
    // Any module in an `operator` folder, the folder's index, `operator.ts`, or the payout listing.
    const guarded = /(^|\/)(operator(\/|(\.[jt]s)?$)|payout-listing(\.[jt]s)?$)/;
    const reaching = sourcesIn(gateway).filter(
      (file) =>
        !own(relative(gateway, file)) &&
        importsOf(file).some((specifier) => guarded.test(specifier)),
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

  it("is reached in the dashboard's pages only through the workspace's layout, which opens its door", () => {
    // The workspace's services hold the reader. The process hands the pages a
    // door, which reads the operator flag; the layout opens it and sets what
    // its pages read. A page that read either elsewhere would reach every
    // merchant's rows from outside the layout's check.
    const dashboard = join(apps, "dashboard");
    const uses: readonly (readonly [RegExp, RegExp])[] = [
      // Opening the door.
      [/\.workspace\b/, /^(app\/routes\/admin\/only\.tsx$|src\/page-services\.ts$|src\/admin\/)/],
      // What the layout set.
      [
        /\bworkspaceIn\(|\bcontext\.(get|set)\(workspace\)/,
        /^(app\/services\.ts|app\/routes\/admin\/)/,
      ],
      // Building the door.
      [/\bworkspaceDoorFor\b/, /^(src\/admin\/|src\/server\.ts$)/],
    ];
    const reaching = [...sourcesIn(join(dashboard, "src")), ...sourcesIn(join(dashboard, "app"))]
      .map((file) => [relative(dashboard, file), readFileSync(file, "utf8")] as const)
      .filter(([path]) => !path.startsWith("src/testing/"))
      .flatMap(([path, text]) =>
        uses
          .filter(([use, allowed]) => use.test(text) && !allowed.test(path))
          .map(([use]) => `${path} ${use}`),
      );

    expect(reaching).toStrictEqual([]);
  });
});
