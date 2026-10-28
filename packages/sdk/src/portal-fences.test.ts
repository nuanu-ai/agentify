/**
 * The documentation's TypeScript examples, compiled against this SDK, so that
 * a renamed method or a changed argument breaks the build rather than the
 * code a merchant pastes from the quickstart. Every ```ts fence on the pages a
 * merchant integrates from becomes a file compiled against the real types.
 *
 * This package's README is one of those pages, and the one with the least
 * margin: it is published in the tarball and is what every reader on npm has
 * until the next release.
 *
 * The examples call the merchant's own functions (`grantAccess`,
 * `startProvisioning`, `currentPriceOf`, `lookupItem`) and use values the page
 * never creates, such as an order saved earlier. Those are declared as globals
 * in the harness below with the shapes the examples imply; they are the
 * harness's assumptions, not promises of the documentation. One fence on the
 * cards page is the `result` block of a card on its own and is compiled as
 * that field. A whole program a page includes from `apps/docs/programs`, such
 * as the quickstart's test buyer, is compiled with them. That one is a buyer's
 * program rather than a merchant's, written against the x402 client a
 * merchant installs to buy their own card, and is compiled against the same
 * release of that client the repository's own test buyer uses. Every page
 * must supply actual nonempty examples, and the compiler must read all of
 * them. The README publication example also runs against an independent
 * shared card fixture, so a blank stand-in cannot satisfy the witness.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { CardSchema } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** This package's own front page, as npm publishes it. */
const README = "packages/sdk/README.md";

/** The card that front page publishes: the smallest one that sells. */
const CARD = "apps/docs/examples/card/access-monthly-short.json";

/**
 * The values and functions the examples use that are the merchant's own,
 * declared globally so that a fence declaring a name of its own shadows the
 * global instead of colliding with it.
 */
const HARNESS = `
import type { AgentifyClient, LiveOrder } from "@nuanu-ai/agentify";

declare global {
  /** The client the quickstart builds on its first page. */
  const agentify: AgentifyClient;
  /**
   * An order the merchant saved when they took it on — the object their
   * handler was given, which carries the calls that close it.
   */
  const order: LiveOrder;
  const orderId: string;
  /** The merchant's own explanation for the buyer, as the orders page describes. */
  const explanationForBuyer: string;
  /** An identifier the merchant kept in their own record, without the order. */
  const savedId: string;
  const url: string;
  const expiresAt: string;
  const until: string;
  function accessFor(orderId: string): Promise<{ url: string; expiresAt: string } | null>;
  /**
   * The seller's own delivery, in the two shapes the pages call it with. The
   * quickstart's card takes an email at purchase and passes it; the README's
   * card declares no purchase parameter at all, so there is no recipient to
   * pass and the delivery it returns carries the second field that card
   * promises. Both are the merchant's function and neither is ours, which is
   * why the harness can hold two shapes without either being a claim.
   */
  function grantAccess(
    recipient: unknown,
    options: { idempotencyKey: string },
  ): Promise<{ ok: boolean; url: string }>;
  function grantAccess(options: {
    idempotencyKey: string;
  }): Promise<{ ok: boolean; url: string; expiresAt: string }>;
  function startProvisioning(
    recipient: unknown,
    options: { idempotencyKey: string },
  ): Promise<void>;
  function currentPriceOf(
    merchantItemId: string,
  ): Promise<{ amount: string; checked_at: string } | null>;
  function lookupItem(
    merchantItemId: string,
  ): Promise<{ in_stock: boolean; price: string; checked_at: string }>;
}
`;

/** The card's result declaration, which is what that fence is a piece of. */
const asCardResult = (body: string): string =>
  `import type { Card } from "@nuanu-ai/agentify";\nconst declared: Pick<Card, "result"> = {\n${body}\n};\nvoid declared;\n`;

interface Page {
  readonly file: string;
  /** The fences that are a piece of something rather than a program. */
  readonly pieces?: Readonly<Record<number, (body: string) => string>>;
}

const PAGES: readonly Page[] = [
  { file: "apps/docs/quickstart.md" },
  { file: "apps/docs/orders.md" },
  { file: "apps/docs/cards.md", pieces: { 0: asCardResult } },
  { file: README },
];

/**
 * The fenced blocks of one language, in page order. Not a markdown parser: a
 * nested or indented fence would come out wrong and fail compilation loudly.
 */
const fencesOf = (markdown: string, language: string): string[] => {
  const blocks: string[] = [];
  let current: string[] | null = null;

  for (const line of markdown.split("\n")) {
    if (current === null) {
      if (line.trim() === `\`\`\`${language}`) current = [];
      continue;
    }
    if (line.trim() === "```") {
      blocks.push(current.join("\n"));
      current = null;
      continue;
    }
    current.push(line);
  }

  return blocks;
};

interface Example {
  /** The name the compiler will print, which says which fence of which page. */
  readonly name: string;
  readonly source: string;
}

const examplesOf = (page: Page): Example[] => {
  const markdown = readFileSync(join(repoRoot, page.file), "utf8");
  const fences = fencesOf(markdown, "ts");

  return fences.map((body, index) => ({
    // Flattened into one directory, so the name carries no separator.
    name: `${page.file.replace(/\.md$/, "").replaceAll("/", "-")}-${index + 1}`,
    source: page.pieces?.[index]?.(body) ?? `${body}\n`,
  }));
};

/** The programs a page includes whole, `<<< @/programs/buyer.mts`, each as the file it is. */
const programsOf = (page: Page): Example[] =>
  readFileSync(join(repoRoot, page.file), "utf8")
    .split("\n")
    .flatMap((line) => /^<<<\s+@\/(programs\/\S+)\.mts$/.exec(line.trim())?.[1] ?? [])
    .map((program) => ({
      name: `apps-docs-${program.replaceAll("/", "-")}`,
      source: readFileSync(join(repoRoot, "apps", "docs", `${program}.mts`), "utf8"),
    }));

interface Compilation {
  readonly ok: boolean;
  readonly output: string;
  /** The examples the compiler read, by name, as it listed its files. */
  readonly read: readonly string[];
}

/**
 * The compiler's printout taken apart: `--listFiles` prints each file it read
 * as a bare absolute path on a line of its own, which an error line never is,
 * and those lines are kept out of the output a failure shows.
 */
const compilationOf = (ok: boolean, printed: string, directory: string): Compilation => {
  const lines = printed.split("\n");
  const isListed = (line: string): boolean => line.startsWith("/") && !line.includes(" ");
  const read = lines
    .filter((line) => isListed(line) && line.includes(`/${basename(directory)}/`))
    .map((line) => basename(line))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => file.slice(0, -".ts".length));

  return { ok, output: lines.filter((line) => !isListed(line)).join("\n"), read };
};

/**
 * Writes the examples out beside a harness and a configuration and compiles
 * them in one pass. The configuration is the repository's own, except that it
 * resolves `@nuanu-ai/agentify` to this package's source, carries a
 * `package.json` marking the files as modules (two examples await at the top
 * level), names the type roots outright (the files sit outside the
 * repository), and allows unused locals, since an example is an excerpt. The
 * buyer's packages are found where the repository's test buyer installs them.
 */
const compile = (examples: readonly Example[]): Compilation => {
  const directory = mkdtempSync(join(tmpdir(), "agentify-fences-"));

  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    symlinkSync(
      join(repoRoot, "packages", "slice", "node_modules"),
      join(directory, "node_modules"),
    );
    writeFileSync(join(directory, "harness.d.ts"), HARNESS);
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        extends: join(repoRoot, "tsconfig.base.json"),
        compilerOptions: {
          noEmit: true,
          types: ["node"],
          typeRoots: [join(repoRoot, "node_modules", "@types")],
          noUnusedLocals: false,
          noUnusedParameters: false,
          paths: { "@nuanu-ai/agentify": [join(repoRoot, "packages", "sdk", "src", "index.ts")] },
        },
        include: ["./*.ts"],
      }),
    );

    for (const example of examples) {
      writeFileSync(join(directory, `${example.name}.ts`), example.source);
    }

    try {
      const output = execFileSync(join(repoRoot, "node_modules", ".bin", "tsc"), [
        "--noEmit",
        "--listFiles",
        "-p",
        join(directory, "tsconfig.json"),
      ]);

      return compilationOf(true, output.toString(), directory);
    } catch (failure) {
      const reported = failure as { stdout?: Buffer; stderr?: Buffer };
      const printed = `${reported.stdout?.toString() ?? ""}${reported.stderr?.toString() ?? ""}`;

      return compilationOf(false, printed, directory);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("the portal's TypeScript examples", () => {
  it("compiles every example on every page against this SDK", () => {
    // If this fails, a merchant who copies the page gets a type error. One
    // compiler pass for all pages, since starting `tsc` is most of the cost;
    // each file is named for its page and fence, so the output says which
    // example broke.
    const examples = PAGES.flatMap((page) => {
      const found = [...examplesOf(page), ...programsOf(page)];
      expect(found.length, `${page.file} must provide a runnable example`).toBeGreaterThan(0);
      for (const example of found) expect(example.source.trim(), example.name).not.toBe("");
      return found;
    });
    const compiled = compile(examples);

    expect(compiled.ok, compiled.output).toBe(true);
    // A pass that read no example passes too, so the compiler has to have
    // read every one of them as a program of its own.
    expect([...compiled.read].sort()).toEqual(examples.map((example) => example.name).sort());
  });
});

/** Where on the page that call is: the second `ts` fence, counting from zero. */
const CARD_FENCE = 1;

describe("the card on the SDK's npm front page", () => {
  it("publishes the shared portal card from the actual npm README example", async () => {
    const expected: unknown = JSON.parse(readFileSync(join(repoRoot, CARD), "utf8"));
    const fence = fencesOf(readFileSync(join(repoRoot, README), "utf8"), "ts")[CARD_FENCE];
    expect(fence, `${README} must contain its publication example`).toBeDefined();
    const published: unknown[] = [];
    await runInNewContext(`(async () => { ${fence} })()`, {
      agentify: {
        catalog: {
          publish: async (card: unknown) => {
            published.push(card);
          },
        },
      },
    });
    expect(published).toHaveLength(1);
    expect(CardSchema.parse(published[0])).toEqual(CardSchema.parse(expected));
  });
});
