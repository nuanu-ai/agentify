import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
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

describe("@nuanu-ai/agentify-contracts", () => {
  it("declares the contract version and keeps zod its only runtime dependency", () => {
    // The version is how the SDK and the gateway tell that they speak the same
    // contract.
    expect(CONTRACT_VERSION).toBe("4");

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
    for (const [name, document] of Object.entries(documents)) {
      expect(
        Object.keys(document).filter((key) => key !== "$id" && key !== "$schema"),
        name,
      ).not.toEqual([]);
    }
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
      "unfulfilled",
      "fulfillment_closed",
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

  it.each([
    ["service_name", "<b>Tea</b>", /plain text.*HTML markup/i],
    ["tags", ["Access", "access"], /same without regard to case/i],
    ["seller_name_request", {}, /one of the two has to be there/i],
    [
      "evm_address",
      "0x52908400098527886E0F7030069857D2E4169Ee7",
      /EIP-55.*checksum.*not part of this document/i,
    ],
  ] as const)(
    "discloses the runtime-only rule omitted from generated %s validation",
    (name, value, disclosure) => {
      const document = toJsonSchemas()[name];
      expect(new Ajv2020({ validateFormats: false }).compile(document)(value)).toBe(true);
      expect(schemas[name].safeParse(value).success).toBe(false);
      expect(document.description).toMatch(disclosure);
    },
  );

  it("discloses runtime-only card rules beside the generated card fields", () => {
    expect(toJsonSchemas().seller_site.description).toMatch(/domain name.*no path.*credentials/i);
    const card = toJsonSchemas().card;
    expect(card.description).toMatch(/plain text.*HTML markup/i);
    expect(card.description).toMatch(/case-insensitive tag uniqueness.*runtime checks/i);
    expect(nested(card.properties?.result).description).toMatch(
      /at least one.*not marked required: false/i,
    );
    const shipment = toJsonSchemas().shipment;
    expect(nested(shipment.properties?.estimated_delivery).description).toMatch(
      /earliest.*no later than.*latest/i,
    );
    expect(nested(shipment.properties?.tracking_url).description).toMatch(
      /no credentials, port or IP address/i,
    );
    expect(nested(shipment.properties?.carrier).description).toMatch(/plain text.*HTML markup/i);
    expect(nested(toJsonSchemas().order_close_request.properties?.message).description).toMatch(
      /bidirectional control.*half of a character/i,
    );
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
