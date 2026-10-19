import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contracts from "./index.js";
import { CONTRACT_VERSION, type JsonSchemaDocument, schemas, toJsonSchemas } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

/**
 * A schema nested inside another one, as an object. JSON Schema allows `true`
 * and `false` where a sub-schema sits, and none of ours are ever that.
 */
const nested = (value: JsonSchemaDocument[keyof JsonSchemaDocument]): JsonSchemaDocument => {
  expect(value, "expected a nested schema object").toBeTypeOf("object");
  return (value ?? {}) as JsonSchemaDocument;
};

/** A zod schema as it is built internally, for the refinement walk below. */
interface ZodInternals {
  _zod?: { def?: Record<string, unknown> };
}

/**
 * The keys under which zod 4 stores one schema inside another. `shape` and
 * `options` hold several; the rest hold one. `getter` is `z.lazy`, which has
 * to be called to yield anything.
 */
const WAYS_A_SCHEMA_HOLDS_ANOTHER = [
  "shape",
  "options",
  "valueType",
  "keyType",
  "innerType",
  "element",
  "items",
  "rest",
  "left",
  "right",
  "in",
  "out",
  "catchall",
  "getter",
] as const;

const callGetter = (getter: unknown): unknown =>
  typeof getter === "function" ? (getter as () => unknown)() : undefined;

const isRefined = (schema: unknown): boolean =>
  (((schema as ZodInternals)._zod?.def?.checks as unknown[]) ?? []).some(
    (check) => (check as ZodInternals)._zod?.def?.check === "custom",
  );

/**
 * Every schema in the registry that carries a refinement, by the path it sits
 * at, nested ones included. The walk is coupled to zod's internals on purpose;
 * a companion test pins what it finds, so a walk that quietly found nothing
 * would fail rather than pass over nothing.
 */
const walkRefined = (
  schema: unknown,
  path: string,
  found: { path: string; described: boolean }[],
  seen: Set<unknown>,
): void => {
  if (schema === null || typeof schema !== "object" || seen.has(schema)) return;
  seen.add(schema);

  const def = (schema as ZodInternals)._zod?.def;
  if (def === undefined) return;

  if (isRefined(schema)) {
    const meta = z.globalRegistry.get(schema as never);
    found.push({ path, described: (meta?.description ?? "").length > 0 });
  }

  // Every way zod holds one schema inside another; the walk is tested against
  // each, since a container it cannot enter hides a refinement silently.
  for (const key of WAYS_A_SCHEMA_HOLDS_ANOTHER) {
    const child = key === "getter" ? callGetter(def[key]) : def[key];
    if (child === undefined) continue;

    if (Array.isArray(child)) {
      for (const [index, option] of child.entries()) {
        walkRefined(option, `${path}[${index}]`, found, seen);
      }
    } else if (key === "shape") {
      for (const [name, field] of Object.entries(child as Record<string, unknown>)) {
        walkRefined(field, `${path}.${name}`, found, seen);
      }
    } else {
      walkRefined(child, path, found, seen);
    }
  }
};

/** The refinements inside one schema, described or not. */
const refinementsIn = (schema: unknown, name: string): { path: string; described: boolean }[] => {
  const found: { path: string; described: boolean }[] = [];
  walkRefined(schema, name, found, new Set<unknown>());
  return found;
};

const refinedSchemas = (): { path: string; described: boolean }[] => {
  const found: { path: string; described: boolean }[] = [];
  const seen = new Set<unknown>();
  for (const [name, schema] of Object.entries(schemas)) walkRefined(schema, name, found, seen);
  return found;
};

const refinedSchemaPaths = (): string[] => refinedSchemas().map((entry) => entry.path);

const refinedSchemasWithoutDescription = (): string[] =>
  refinedSchemas()
    .filter((entry) => !entry.described)
    .map((entry) => entry.path);

describe("@nuanu-ai/agentify-contracts", () => {
  it("declares the contract version and keeps zod its only runtime dependency", () => {
    // The version is how the SDK and the gateway tell that they speak the same
    // contract.
    expect(CONTRACT_VERSION).toBe("2");

    // This package is the whole of what the SDK brings into a merchant's
    // install besides zod, so anything more here is something extra for them.
    expect(Object.keys(manifest.dependencies ?? {})).toStrictEqual(["zod"]);
  });

  it("validates with the very version of zod the gateway does", () => {
    // A merchant's offline card check and the gateway's publication are one
    // check only on one exact zod version: releases have differed, for one, in
    // how they count a string's length.
    const zodOf = (path: string): string | undefined =>
      (
        JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as {
          dependencies?: Record<string, string>;
        }
      ).dependencies?.zod;
    const ours = manifest.dependencies?.zod ?? "";

    expect(ours).toMatch(/^\d+\.\d+\.\d+$/);
    expect(zodOf("../../../apps/gateway/package.json")).toBe(ours);
    expect(zodOf("../../../apps/dashboard/package.json")).toBe(ours);
  });
});

describe("the registry of schemas", () => {
  it("holds every schema this package exports", () => {
    // The promise: the contract has one list. A schema not registered is
    // invisible to the JSON Schema export, the only way an engineer outside
    // TypeScript reads it.
    const registered = new Set<unknown>(Object.values(schemas));
    const missing = Object.entries(contracts)
      .filter(([name, value]) => name.endsWith("Schema") && !registered.has(value))
      .map(([name]) => name);

    expect(missing).toStrictEqual([]);
  });

  it("is reachable from outside this package, every bit of it", async () => {
    // The package has one entry point, so a schema not re-exported from it
    // does not exist for a consumer. Walking the modules, rather than listing
    // them, catches the next schema added to a file nobody re-exports.
    const publicModules = readdirSync(new URL(".", import.meta.url))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "index.ts")
      .sort();

    expect(publicModules.length).toBeGreaterThan(5);

    const exported = new Set(Object.keys(contracts));
    const unreachable: string[] = [];

    for (const file of publicModules) {
      const module = (await import(`./${file.replace(/\.ts$/, ".js")}`)) as Record<string, unknown>;
      for (const name of Object.keys(module)) {
        if (!exported.has(name)) unreachable.push(`${file}: ${name}`);
      }
    }

    expect(unreachable).toStrictEqual([]);
  });

  it("registers nothing under a name that is not written the way the wire is", () => {
    // Registry names are what a consumer outside TypeScript sees, and wire
    // fields are snake_case.
    for (const name of Object.keys(schemas)) {
      expect(name, name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("the contract as JSON Schema", () => {
  it("converts every schema in the registry", () => {
    // The promise: an engineer outside TypeScript gets the same contract. A
    // schema with no JSON Schema equivalent fails here, not in their generator.
    const documents = toJsonSchemas();

    expect(Object.keys(documents).sort()).toStrictEqual(Object.keys(schemas).sort());
  });

  it("describes something in every document, not only the ones read back below", () => {
    // The tests below read a few documents in detail; this catches any
    // document reduced to its name.
    const empty = Object.entries(toJsonSchemas())
      .filter(
        ([, document]) =>
          Object.keys(document).filter((key) => key !== "$id" && key !== "$schema").length === 0,
      )
      .map(([name]) => name);

    expect(empty).toStrictEqual([]);
  });

  it("stamps each document with the contract version it came from", () => {
    // Without it the document is a contract of unknown version, and the
    // readers furthest away cannot ask.
    const documents = toJsonSchemas();

    for (const [name, document] of Object.entries(documents)) {
      expect(document.$id, name).toBe(`urn:agentify:contract:${CONTRACT_VERSION}:${name}`);
    }
  });

  // These read documents back, one per kind of structure the registry holds,
  // so a conversion producing empty documents cannot pass.

  it("describes an object with its required fields and its closed shape", () => {
    const money = toJsonSchemas().money;

    expect(money.type).toBe("object");
    expect(money.required).toStrictEqual(["amount", "currency"]);
    expect(money.additionalProperties).toBe(false);
    expect(money.properties?.amount).toMatchObject({ type: "string" });
  });

  it("describes an enumeration as its values and nothing else", () => {
    // One enumeration shows how enumerations render; the fulfillment modes are
    // asserted in `card.test.ts`.
    expect(toJsonSchemas().receipt_outcome.enum).toStrictEqual([
      "in_progress",
      "delivered",
      "shipped",
      "refund_due",
      "refunded",
    ]);
  });

  it("describes a plain union as its branches", () => {
    const answer = toJsonSchemas().handler_answer;
    const branches = answer.anyOf ?? answer.oneOf ?? [];

    expect(branches).toHaveLength(3);
    expect(branches.flatMap((branch) => branch.required ?? []).sort()).toStrictEqual([
      "accepted",
      "delivered",
      "refused",
    ]);
  });

  it("describes a discriminated union as branches pinned to their discriminator", () => {
    const answer = toJsonSchemas().quote_response;
    const branches = answer.anyOf ?? answer.oneOf ?? [];

    expect(branches).toHaveLength(2);
    expect(branches.map((branch) => nested(branch.properties?.available).const)).toStrictEqual([
      true,
      false,
    ]);
    // A price on one branch, none on the other.
    expect(branches[0]?.required).toContain("price");
    expect(branches[1]?.required).not.toContain("price");
    expect(branches[1]?.properties?.price).toBeUndefined();
  });

  it("describes a record by what its keys and its values have to look like", () => {
    const spec = toJsonSchemas().param_spec;

    expect(spec.propertyNames).toMatchObject({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" });
    expect(spec.additionalProperties).toMatchObject({ required: ["type"] });
  });

  it("exports the identifier rule whole, and it means the same thing there", () => {
    // The pattern is read back and run, since a pattern that is present and
    // matches everything would pass a test that only looked for one; a
    // generated client should refuse the keys this contract refuses.
    const pattern = toJsonSchemas().identifier.pattern;

    expect(pattern).toBeTypeOf("string");
    const accepts = (value: string) => new RegExp(pattern ?? "", "u").test(value);

    expect(accepts("access-monthly")).toBe(true);
    expect(accepts("SKU 100/1")).toBe(true);
    expect(accepts("")).toBe(false);
    expect(accepts("access-monthly ")).toBe(false);
    expect(accepts("a\u0000b")).toBe(false);
    expect(accepts("access-monthly\u200b")).toBe(false);
  });

  it("leaves no refinement undescribed, anywhere in the registry", () => {
    // A rule written as a refinement vanishes from the export without a word.
    // Add a refinement anywhere and this asks for the sentence that tells a
    // generator's reader what is not being checked. It reads zod's internals
    // on purpose: if their shape changes, this breaks loudly.
    const undescribed = refinedSchemasWithoutDescription();

    expect(undescribed).toStrictEqual([]);
  });

  it("finds the refinements it is supposed to be checking", () => {
    // The other half: a walk that found nothing would satisfy the invariant
    // above and check nothing. These are the refinements the package has.
    //
    // `card.result` and `public_card.result` are one rule on two declarations,
    // the published card's closed one and the agent's open one. `card.tags`:
    // two tags differing only in case are one tag to a discovery listing.
    // `evm_address`: the checksum needs a hash, so it cannot be a pattern; the
    // payout wallet documents reach it too, reported once under the entry the
    // walk meets first. `merchant_card.card` is the stored card, with the rules
    // between fields but not the plain-text rule. `agent_order_status.seller.site`
    // is a seller's site, whose origin only the URL parser can check; the
    // catalog's cards and the seller-name documents share it.
    // `seller_name_request` compares its two fields, and
    // `seller_name_request.seller_name` is the name's plain-text rule.
    // `agent_order_status.shipment.carrier` and `.tracking_number` are held to
    // plain text, `.tracking_url` to an address, and `.estimated_delivery`
    // compares its two ends; the merchant's shipment shares them, except the
    // window, which an agent reads open and which is met again under
    // `shipment`.
    expect(refinedSchemaPaths().sort()).toStrictEqual([
      "agent_order_status.seller.site",
      "agent_order_status.shipment.carrier",
      "agent_order_status.shipment.estimated_delivery",
      "agent_order_status.shipment.tracking_number",
      "agent_order_status.shipment.tracking_url",
      "card",
      "card.result",
      "card.tags",
      "evm_address",
      "merchant_card.card",
      "public_card.result",
      "seller_name_request",
      "seller_name_request.seller_name",
      "shipment.estimated_delivery",
    ]);
  });

  it("would notice an undescribed refinement, including a nested one", () => {
    // The third part: with every refinement described, the invariant passes
    // whether or not it demands a description. These unregistered schemas
    // exercise the demand itself.
    const undescribed = z.string().refine(() => true);
    const described = z
      .string()
      .refine(() => true)
      .meta({ description: "says what it checks" });

    expect(refinementsIn(undescribed, "bare")).toStrictEqual([{ path: "bare", described: false }]);
    expect(refinementsIn(described, "bare")).toStrictEqual([{ path: "bare", described: true }]);

    // Nested.
    expect(refinementsIn(z.strictObject({ field: undescribed }), "holder")).toStrictEqual([
      { path: "holder.field", described: false },
    ]);

    // And a schema with no refinement at all contributes nothing.
    expect(refinementsIn(z.string(), "plain")).toStrictEqual([]);
  });

  it("reaches inside every way zod holds one schema in another", () => {
    // The companion test above is not the guard it looks like: a container the
    // walk cannot enter contributes nothing, and the found set stays as
    // expected while a refinement's rule vanishes from the export.
    const hidden = z.string().refine(() => true);
    const containers: [string, z.ZodType][] = [
      ["object", z.strictObject({ field: hidden })],
      ["record value", z.record(z.string(), hidden)],
      ["array", z.array(hidden)],
      ["optional", hidden.optional()],
      ["nullable", hidden.nullable()],
      ["default", hidden.default("x")],
      ["union", z.union([hidden, z.number()])],
      ["tuple", z.tuple([hidden])],
      ["tuple rest", z.tuple([z.string()], hidden)],
      ["intersection left", z.intersection(hidden, z.string())],
      ["intersection right", z.intersection(z.string(), hidden)],
      // A pipe holds one on each side, and each is tested.
      ["pipe out", z.string().pipe(hidden)],
      ["pipe in", hidden.pipe(z.string())],
      ["lazy", z.lazy(() => hidden)],
      ["catchall", z.object({}).catchall(hidden)],
    ];

    const blind = containers
      .filter(([, container]) => refinementsIn(container, "held").length === 0)
      .map(([name]) => name);

    expect(blind).toStrictEqual([]);
  });

  it("carries the open code dictionaries, which no structure can hold", () => {
    // An open set has no `enum` to render, so without a description the
    // recommended codes would reach the export as a bare string type.
    const documents = toJsonSchemas();
    const refusal = documents.refusal_code.description ?? "";

    for (const code of Object.values(contracts.RECOMMENDED_REFUSAL_CODES)) {
      expect(refusal, code).toContain(code);
    }
    expect(refusal).toContain("open");

    const callError = nested(documents.call_error.properties?.code).description ?? "";
    for (const code of [...contracts.ORDER_CALL_ERROR_CODES, contracts.CARD_REJECTED]) {
      expect(callError, code).toContain(code);
    }

    // A finding's code is open too, and the merchant findings are the ones a
    // program branches on, so they travel with the field.
    const finding = nested(documents.problem.properties?.code).description ?? "";
    for (const code of Object.values(contracts.MERCHANT_FINDINGS)) {
      expect(finding, code).toContain(code);
    }
  });

  it("carries the result's size and the price handler as structural rules", () => {
    const card = toJsonSchemas().card;
    expect(card.properties?.result).toMatchObject({ minProperties: 1 });
    expect(nested(card.properties?.price_check)).toMatchObject({ const: "handler" });
  });
});
