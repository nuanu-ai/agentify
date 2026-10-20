/**
 * Sentences this repository has retired, which must not come back. A phrase
 * earns a line here only after it was believed, written down and found to be
 * false, and the line records what is true instead, so whoever trips it learns
 * something rather than searching for a synonym. This is not a style checker.
 * The decision records are searched too, because a corrected decision is edited
 * in place.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * Walked with the standard library rather than a glob package: a dependency
 * added for one search has to be justified at every release afterwards.
 * React Router's generated route types under `.react-router` are skipped: no
 * one writes a sentence there, and the route tests rewrite them while this
 * file reads the tree.
 */
const LOOK_IN = ["apps", "packages", "docs/research", "docs/decisions"];
const READABLE = /\.(ts|md)$/;
const SKIP = new Set(["node_modules", "dist", ".vitepress", "cache", ".react-router"]);

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) {
      continue;
    }
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...filesUnder(path));
    } else if (READABLE.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

const everyFile = (): string[] => LOOK_IN.flatMap(filesUnder);

/** Where a retired sentence is allowed to survive: this file quotes them all. */
const EXEMPT = [/retired-claims\.test\.ts$/];

interface Retired {
  /** The words, lowercased, as they were actually written. */
  readonly words: string;
  /** What is true instead, in one sentence a reader can act on. */
  readonly instead: string;
}

const RETIRED: readonly Retired[] = [
  {
    words: "under the same envelope identifier",
    instead:
      "each attempt at an order is a fresh envelope with an identifier of its own; a handler recognises a repeat by the order's identifier inside the payload",
  },
  {
    words: "share no field but the payload",
    instead:
      "two attempts share their kind as well — the only thing they have in common that matters is the order they carry",
  },
  {
    words: "redelivery by visibility timeout",
    instead:
      "the queue's own retries are off; redelivery is decided by the order machine, and a drawn envelope is never re-offered",
  },
  {
    words: "if the refund has gone out",
    instead:
      "late delivery remains possible on an unfulfilled paid order until the merchant closes Agentify fulfillment; any refund or other agreement remains between the merchant and buyer",
  },
];

describe("sentences this repository has retired", () => {
  it("does not carry any of them back into the tree", () => {
    const files = everyFile();
    // A search that found nothing to search would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(100);

    const found: string[] = [];
    for (const path of files) {
      if (EXEMPT.some((exempt) => exempt.test(path))) {
        continue;
      }
      const text = readFileSync(resolve(root, path), "utf8").toLowerCase();
      for (const claim of RETIRED) {
        if (text.includes(claim.words)) {
          found.push(`${path}: "${claim.words}" — ${claim.instead}`);
        }
      }
    }

    expect(found).toStrictEqual([]);
  });

  it("is looking in the places these claims actually spread to", () => {
    // The list above is only worth its line if the search reaches the files
    // that carried the claim: the contract a client is generated from, the
    // queue adapters, the SDK and the merchant's own pages. A glob that
    // silently stopped matching one of them would pass this suite while the
    // claim walked back in through it.
    const files = everyFile();

    for (const wanted of [
      "packages/contracts/src/api.ts",
      "packages/contracts/src/envelope.ts",
      "packages/sdk/src/worker.ts",
      "apps/gateway/src/ports/queue.ts",
      "apps/gateway/src/adapters/pgboss/queue.ts",
      "apps/docs/orders.md",
    ]) {
      expect(files).toContain(wanted);
    }
  });
});
