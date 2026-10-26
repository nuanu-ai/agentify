/**
 * Every `pattern` attribute the scanner's pages give a form field is one the
 * browser enforces. A browser compiles the attribute with the `v` flag, and
 * one that does not compile under it is ignored without a word: the field then
 * takes anything and the server refuses what the page let through. Each value
 * is read by the type checker, so a pattern named by a constant is checked as
 * well as one written in place; a value the checker cannot read as one string
 * fails here, since nothing could vouch for it.
 *
 * It reads the `.tsx` files of this app alone, and checks only that each
 * pattern compiles: whether it matches what the server takes is held beside
 * the rule it comes from.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const APP = fileURLToPath(new URL(".", import.meta.url));
const SKIPPED = new Set(["node_modules", "dist", "build", ".react-router"]);

const sourcesIn = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourcesIn(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
  });

type Found = Readonly<{ where: string; value: string | undefined }>;

const patternAttributes = (): Found[] => {
  const files = sourcesIn(APP).filter((file) => readFileSync(file, "utf8").includes("pattern"));
  const config = ts.getParsedCommandLineOfConfigFile(
    join(APP, "tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  const program = ts.createProgram(files, config?.options ?? {});
  const checker = program.getTypeChecker();
  const stringOf = (expression: ts.Expression | undefined): string | undefined => {
    if (expression === undefined) return undefined;
    if (ts.isStringLiteralLike(expression)) return expression.text;
    const type = checker.getTypeAtLocation(expression);
    return type.isStringLiteral() ? type.value : undefined;
  };
  const found: Found[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (source === undefined) continue;
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "pattern") {
        const where = `${relative(APP, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        const initializer = node.initializer;
        const expression =
          initializer !== undefined && ts.isJsxExpression(initializer)
            ? initializer.expression
            : initializer;
        found.push({ where, value: stringOf(expression) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
};

const compileError = (pattern: string): string | null => {
  try {
    new RegExp(`^(?:${pattern})$`, "v");
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

describe("a form field's pattern", () => {
  const found = patternAttributes();

  it("is given to the report request's phone field", () => {
    expect(found.some(({ where }) => where.startsWith("components/registration-form.tsx"))).toBe(
      true,
    );
  });

  it.each(found.map(({ where, value }) => [where, value] as const))(
    "at %s is one string the browser compiles and enforces",
    (_where, value) => {
      expect(value, "a pattern the type checker cannot read as one string").toBeTypeOf("string");
      expect(compileError(value ?? "")).toBeNull();
    },
  );
});
