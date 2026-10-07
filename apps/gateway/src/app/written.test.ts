/**
 * What this gateway writes on the storefront, held shut at every depth.
 *
 * An agent reads the catalog and an order's status open, inside and out
 * (ADR-0006 §5), so its schema cannot refuse a field that should not be there.
 * The outbound check is where one is stopped, and it stops only what its own
 * forms shut: an object left open anywhere inside them is a place a merchant's
 * key or a buyer's parameter could ride out to every agent with nothing
 * failing.
 */

import { AgentOrderStatusSchema, CatalogPageSchema } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WRITTEN_AS } from "./written.js";

type Node = Record<string, unknown>;

/** Every object in a JSON Schema document that names its fields and lets others in. */
function openObjectsIn(node: unknown, at: string, found: string[]): string[] {
  if (Array.isArray(node)) {
    node.forEach((each, index) => openObjectsIn(each, `${at}[${index}]`, found));
    return found;
  }
  if (typeof node !== "object" || node === null) return found;
  const schema = node as Node;
  if (schema.properties !== undefined && schema.additionalProperties !== false) {
    found.push(at);
  }
  for (const [key, value] of Object.entries(schema)) {
    openObjectsIn(value, `${at}.${key}`, found);
  }
  return found;
}

describe("what this gateway writes on the storefront", () => {
  for (const [name, read] of [
    ["the catalog", CatalogPageSchema],
    ["an order's status", AgentOrderStatusSchema],
  ] as const) {
    it(`writes ${name} with every object in it shut`, () => {
      const written = WRITTEN_AS.get(read);
      if (written === undefined) throw new Error(`${name} goes out held to its open form`);

      expect(openObjectsIn(z.toJSONSchema(written), "$", [])).toStrictEqual([]);
    });
  }

  it("reads the same documents open, so the check above is not the reader's", () => {
    // The negative control: the forms an agent reads have open objects in
    // them, and a walk that found none there would be finding nothing at all.
    expect(openObjectsIn(z.toJSONSchema(AgentOrderStatusSchema), "$", [])).not.toStrictEqual([]);
  });
});
