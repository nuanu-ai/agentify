/**
 * Holds the documentation's payload examples to the schemas. Every example is
 * one file, `apps/docs/examples/<schema>/<name>.json`, which the page shows by
 * snippet import (`<<< @/examples/…`), so the bytes a merchant reads are the
 * bytes this test parses.
 *
 * Every file passes the schema its directory names; every file is shown by at
 * least one page; every include resolves to a file; and no page carries a
 * payload inline, which would walk around the rest.
 *
 * A whole program a reader saves and runs, such as the quickstart's test
 * buyer, is one file too, `apps/docs/programs/<name>`, included the same way.
 * Nothing here parses it: `packages/sdk/src/portal-fences.test.ts` compiles
 * it and `packages/slice/src/quickstart-buyer.test.ts` runs it. This file
 * holds only that every program is shown by a page.
 *
 * TypeScript fences are calling code, not documents, and are compiled against
 * the SDK by `packages/sdk/src/portal-fences.test.ts`. A page discussing a
 * piece of a document, such as a card's `result` block, keeps it as a
 * TypeScript fence; anything written as JSON has to be a whole document in a
 * file, since a merchant copies what they see.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { CardSchema, deliveryCheckFor } from "./card.js";
import { QuoteRequestSchema, QuoteResponseSchema } from "./quote.js";

const PORTAL = fileURLToPath(new URL("../../../apps/docs/", import.meta.url));
const EXAMPLES = join(PORTAL, "examples");
const PROGRAMS = join(PORTAL, "programs");

/**
 * Which schema each directory of examples is held to. A directory missing from
 * it fails rather than holding unchecked examples.
 */
const SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  card: CardSchema,
  "quote-request": QuoteRequestSchema,
  "quote-response": QuoteResponseSchema,
};

/** The writing guide addressed to authors, which the site does not build. */
const NOT_A_PAGE = "WRITING.md";

const entriesOfExamples = readdirSync(EXAMPLES, { withFileTypes: true });

/** Every example, by the path a page includes it with: `card/access-monthly.json`. */
const files: readonly string[] = entriesOfExamples
  .filter((entry) => entry.isDirectory())
  .flatMap((directory) =>
    readdirSync(join(EXAMPLES, directory.name)).map((name) => `${directory.name}/${name}`),
  )
  .sort();

/** Every program, by the path a page includes it with: `programs/buyer.mts`. */
const programs: readonly string[] = readdirSync(PROGRAMS)
  .map((name) => `programs/${name}`)
  .sort();

const pages: readonly string[] = readdirSync(PORTAL)
  .filter((name) => name.endsWith(".md") && name !== NOT_A_PAGE)
  .sort();

const textOf = (page: string): string => readFileSync(join(PORTAL, page), "utf8");

/**
 * The snippet imports a page writes, as the path each names. A region
 * (`#name`) and options (`{2,4}`) after the path are cut; `@/` is the docs
 * source root.
 */
const includesOf = (markdown: string): string[] =>
  markdown
    .split("\n")
    .map((line) => /^<<<\s+(\S+)/.exec(line.trim())?.[1])
    .filter((path) => path !== undefined)
    .map((path) => path.replace(/[#{].*$/, "").replace(/^@\//, ""));

/** Every path any page includes, and the pages that include it. */
const included = new Map<string, string[]>();
for (const page of pages) {
  for (const path of includesOf(textOf(page))) {
    included.set(path, [...(included.get(path) ?? []), page]);
  }
}

const jsonOf = (file: string): unknown => {
  const text = readFileSync(join(EXAMPLES, file), "utf8");

  try {
    return JSON.parse(text);
  } catch (failure) {
    throw new Error(`apps/docs/examples/${file} is not valid JSON: ${(failure as Error).message}`);
  }
};

describe("the portal's examples are files, and every file is checked", () => {
  it("keeps every example in a directory that names a schema", () => {
    // Where an unchecked example would otherwise hide: a file dropped at the
    // top of the tree, or a directory nobody mapped to a schema.
    expect(files.length, "no example files found").toBeGreaterThan(0);
    expect(included.size, "no page includes examples").toBeGreaterThan(0);
    const loose = entriesOfExamples.filter((entry) => !entry.isDirectory()).map((e) => e.name);
    const unmapped = entriesOfExamples
      .filter((entry) => entry.isDirectory() && SCHEMAS[entry.name] === undefined)
      .map((entry) => entry.name);

    expect(loose, "an example belongs in a directory named for its schema").toStrictEqual([]);
    expect(
      unmapped,
      "no schema is mapped to this directory, so nothing here would be validated; add it to SCHEMAS",
    ).toStrictEqual([]);
  });

  it.each(files)("%s passes the schema its directory names", (file) => {
    // If this fails, a merchant who copied this example got a document the
    // gateway would refuse.
    expect(included.get(`examples/${file}`) ?? [], `no page displays ${file}`).not.toEqual([]);
    const [directory = ""] = file.split("/");
    const schema = SCHEMAS[directory];

    expect(file.endsWith(".json"), `${file} is not JSON, and nothing here can check it`).toBe(true);
    expect(schema, `no schema for ${directory}`).toBeDefined();

    const result = schema?.safeParse(jsonOf(file));

    expect(
      result?.success === true ? "" : JSON.stringify(result?.error?.issues),
      `apps/docs/examples/${file} does not pass ${directory}`,
    ).toBe("");
  });

  it("includes nothing that is not there", () => {
    // A page pointing at a missing file renders an empty block.
    for (const program of programs) {
      expect(included.get(program) ?? [], `no page displays ${program}`).not.toEqual([]);
    }
    const known = new Set([...files.map((file) => `examples/${file}`), ...programs]);
    const missing = [...included.entries()]
      .filter(([path]) => !known.has(path))
      .map(([path, where]) => `${path} (included by ${where.join(", ")})`);

    expect(
      missing,
      "a page includes a file that is in neither apps/docs/examples nor apps/docs/programs",
    ).toStrictEqual([]);
  });

  it.each(pages)("%s writes no payload inline", (page) => {
    // A payload written back into a fence passes no schema and belongs to no
    // file. A fence whose whole body is a value the build writes in, such as
    // `{{parcel-purchase}}`, is rendered from the contract, and the
    // documentation's own tests hold what it renders to the schema.
    const lines = textOf(page).split("\n");
    const inline = lines.filter(
      (line, index) =>
        /^```(json|http)\b/.test(line.trim()) &&
        !(
          /^\{\{[a-z-]+\}\}$/.test(lines[index + 1]?.trim() ?? "") &&
          lines[index + 2]?.trim() === "```"
        ),
    );

    expect(
      inline,
      `${page} writes a payload in a fence; put it in apps/docs/examples and include it with <<<`,
    ).toStrictEqual([]);
  });
});

describe("the pages agree with each other", () => {
  it("shows the same card written short and written out in full", () => {
    // The card reference prints one product twice, short and written out, and
    // says the two are the same card. They are compared as parsed, since the
    // short form is opened out at publication.
    expect(CardSchema.parse(jsonOf("card/access-monthly-short.json"))).toStrictEqual(
      CardSchema.parse(jsonOf("card/access-monthly.json")),
    );
  });

  it("executes the orders page examples and validates their actual delivery payloads", async () => {
    const check = deliveryCheckFor(CardSchema.parse(jsonOf("card/access-monthly.json")));
    const delivered: unknown[] = [];
    const url = "https://example.com/a/9f2c4a";
    const until = "2026-09-25T10:00:00Z";
    const order = {
      id: "ord_saved",
      status: "in_progress",
      deliver: async (goods: unknown) => {
        delivered.push(goods);
      },
      refuse: async () => {},
      close: async () => {},
    };
    const context = {
      order,
      url,
      until,
      expiresAt: until,
      orderId: order.id,
      savedId: order.id,
      explanationForBuyer: "Fulfillment closed by merchant",
      accessFor: async () => ({ url, expiresAt: until }),
      agentify: {
        orders: { forId: () => order, get: async () => order, list: async () => [order] },
      },
    };
    const examples = [...textOf("orders.md").matchAll(/^```ts\n([\s\S]*?)^```$/gm)];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples)
      await runInNewContext(`(async () => { ${example[1]} })()`, context);
    expect(delivered.length, "the actual page must demonstrate a delivery").toBeGreaterThan(0);
    for (const goods of delivered) {
      expect(goods).toEqual({ access_url: url, expires_at: until });
      expect(check.parse(goods)).toEqual({ access_url: url, expires_at: until });
    }
  });
});
