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
 * that field. The quickstart's test purchase is a buyer's program rather than
 * a merchant's, written against the x402 client a merchant installs to buy
 * their own card; it is compiled against the same release of that client the
 * repository's own test buyer uses. The count of fences per page is asserted,
 * so a new example cannot slip past: when it fails, decide how the new fence is
 * compiled.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  /** How many ```ts fences the page carries. Raised only with a decision. */
  readonly fences: number;
  /** The fences that are a piece of something rather than a program. */
  readonly pieces?: Readonly<Record<number, (body: string) => string>>;
}

const PAGES: readonly Page[] = [
  { file: "apps/docs/quickstart.md", fences: 7 },
  { file: "apps/docs/orders.md", fences: 6 },
  { file: "apps/docs/cards.md", fences: 2, pieces: { 0: asCardResult } },
  { file: README, fences: 4 },
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

interface Compilation {
  readonly ok: boolean;
  readonly output: string;
}

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
        "-p",
        join(directory, "tsconfig.json"),
      ]);

      return { ok: true, output: output.toString() };
    } catch (failure) {
      const reported = failure as { stdout?: Buffer; stderr?: Buffer };

      return {
        ok: false,
        output: `${reported.stdout?.toString() ?? ""}${reported.stderr?.toString() ?? ""}`,
      };
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
    const compiled = compile(PAGES.flatMap(examplesOf));

    expect(compiled.ok, compiled.output).toBe(true);
  });

  it.each(PAGES)("has the examples this harness knows about on $file", (page) => {
    // A new example has to be compiled too; raising this number is the moment
    // to decide how.
    expect(examplesOf(page)).toHaveLength(page.fences);
  });

  it("compiles the pages' own code and not a blank stand-in for it", () => {
    // Empty fences compile too. This checks that the compiler is given the
    // merchant's whole promised surface, method by method, so it fails if the
    // harness stops reading the pages or a page stops documenting a call.
    const everything = PAGES.flatMap((page) => examplesOf(page))
      .map((example) => example.source)
      .join("\n");

    for (const promised of [
      "createClient",
      "agentify.catalog.publish",
      "agentify.on('order'",
      "agentify.on('quote'",
      "agentify.start()",
      "order.delivered(",
      "order.refused(",
      "order.accepted(",
      "order.deliver(",
      "order.refuse(",
      "agentify.orders.forId(",
      "agentify.orders.get",
      "agentify.orders.list",
    ]) {
      expect(everything).toContain(promised);
    }
  });

  it("would notice a method this SDK does not have", () => {
    // The negative control for the harness: the checks above would pass just
    // as well if the compiler never saw the SDK or the examples never reached
    // it.
    const broken = compile([
      { name: "renamed", source: "await agentify.catalog.publishTheCard({})\n" },
      { name: "wrong-argument", source: "await agentify.orders.get(42)\n" },
      {
        // The handler's kind is checked too; `orders` would register a handler
        // nothing calls.
        name: "wrong-kind",
        source: "agentify.on('orders', () => ({ accepted: {} }))\n",
      },
    ]);

    expect(broken.ok).toBe(false);
    expect(broken.output).toMatch(/publishTheCard/);
    expect(broken.output).toMatch(/wrong-argument/);
    expect(broken.output).toMatch(/wrong-kind/);
  });
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A value as the front page writes it: strings quoted, a record on one line. */
const inlineOf = (value: unknown): string => {
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

  if (isRecord(value)) {
    const fields = Object.entries(value).map(([name, child]) => `${name}: ${inlineOf(child)}`);

    return `{ ${fields.join(", ")} }`;
  }

  return String(value);
};

/** The card, as the call that publishes it — which is what the fence has to be. */
const publishCallFor = (card: Record<string, unknown>): string =>
  [
    "await agentify.catalog.publish({",
    ...Object.entries(card).map(([name, value]) => `  ${name}: ${inlineOf(value)},`),
    "})",
  ].join("\n");

/** Where on the page that call is: the second `ts` fence, counting from zero. */
const CARD_FENCE = 1;

describe("the card on the SDK's npm front page", () => {
  it("is the card the portal's examples hold, rendered as the call that publishes it", () => {
    // npm cannot render a file by reference, so the README holds a copy of the
    // card, and this keeps the copy safe: the fence is compared against text
    // rendered from the fixture itself, the same fixture the landing page
    // renders and `portal-fixtures.test.ts` holds to `CardSchema`. If this
    // fails, change the fixture, not the fence.
    const card: unknown = JSON.parse(readFileSync(join(repoRoot, CARD), "utf8"));

    expect(isRecord(card), `${CARD} is not an object`).toBe(true);

    const fence = fencesOf(readFileSync(join(repoRoot, README), "utf8"), "ts")[CARD_FENCE];

    expect(fence, `${README} has no card fence where this test looks for one`).toBeDefined();
    expect(fence).toBe(publishCallFor(card as Record<string, unknown>));
  });

  it("shows every name and every value that card carries", () => {
    // The control on the rendering, read off the page: the assertion above
    // also passes if the renderer drops a field, and a card with no `result`
    // would be a product promising nothing.
    const card: unknown = JSON.parse(readFileSync(join(repoRoot, CARD), "utf8"));
    const wordsOf = (value: unknown): string[] =>
      isRecord(value)
        ? Object.entries(value).flatMap(([name, child]) => [name, ...wordsOf(child)])
        : [String(value)];

    const fence = fencesOf(readFileSync(join(repoRoot, README), "utf8"), "ts")[CARD_FENCE] ?? "";
    const missing = wordsOf(card).filter((word) => !fence.includes(word));

    expect(missing, `${README} shows a card with these left out`).toStrictEqual([]);
  });
});
