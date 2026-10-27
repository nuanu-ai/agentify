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
import ts from "typescript";
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

  it("keeps resolved workspace capabilities inside their authenticated boundary, including aliases", () => {
    const dashboard = join(apps, "dashboard");
    const files = [...sourcesIn(join(dashboard, "src")), ...sourcesIn(join(dashboard, "app"))];
    const config = ts.readConfigFile(join(dashboard, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dashboard);
    const program = ts.createProgram(files, parsed.options);
    const checker = program.getTypeChecker();
    const exported = (file: string, name: string): ts.Symbol => {
      const source = program.getSourceFile(join(dashboard, file));
      const module = source && checker.getSymbolAtLocation(source);
      const found =
        module && checker.getExportsOfModule(module).find((symbol) => symbol.name === name);
      if (!found) throw new Error(`missing capability owner ${file}: ${name}`);
      return found;
    };
    const pageServices = exported("src/page-services.ts", "PageServices");
    const door = checker.getDeclaredTypeOfSymbol(pageServices).getProperty("workspace");
    if (!door) throw new Error("page services have no workspace capability");
    const boundaries = new Map<ts.Symbol, RegExp>([
      [door, /^(app\/routes\/admin\/only\.tsx$|src\/page-services\.ts$|src\/admin\/)/],
      [exported("app/services.ts", "workspace"), /^(app\/services\.ts$|app\/routes\/admin\/)/],
      [exported("app/services.ts", "workspaceIn"), /^(app\/services\.ts$|app\/routes\/admin\/)/],
      [exported("src/admin/index.ts", "workspaceDoorFor"), /^(src\/admin\/|src\/server\.ts$)/],
    ]);
    const reaching: string[] = [];
    for (const file of files) {
      const path = relative(dashboard, file);
      if (path.startsWith("src/testing/")) continue;
      const source = program.getSourceFile(file);
      if (!source) throw new Error(`source not resolved: ${path}`);
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          let symbol = checker.getSymbolAtLocation(node);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias)
            symbol = checker.getAliasedSymbol(symbol);
          const allowed = symbol && boundaries.get(symbol);
          if (allowed && !allowed.test(path)) {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            reaching.push(`${path}:${line}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(reaching).toStrictEqual([]);
  });
});
