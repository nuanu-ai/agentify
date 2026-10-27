/**
 * What the stand fills into a card's declared fields. A delivery the checks
 * refuse reads on the page as a gateway that would not take the goods, and a
 * purchase missing a parameter reads as a card published wrong. So what is
 * checked here is not the shape of the values but that they survive the
 * validators the product applies to them, in both directions.
 */

import { type ParamSpec, paramSpecToValidator } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { filledFrom } from "./stand-goods.js";

const EVERY_TYPE: ParamSpec = {
  activation_code: { type: "string", title: "The activation code" },
  seats: { type: "integer" },
  weight: { type: "number" },
  refundable: { type: "boolean" },
};

describe("filling a card's declarations", () => {
  it("produces a delivery the delivery check accepts", () => {
    const goods = filledFrom(EVERY_TYPE);
    expect(() => paramSpecToValidator(EVERY_TYPE, "delivery").parse(goods)).not.toThrow();
    expect(goods.activation_code).toEqual(expect.any(String));
    expect(String(goods.activation_code).length).toBeGreaterThan(0);
  });

  it("produces purchase parameters the purchase check accepts", () => {
    const params: ParamSpec = {
      email: { type: "string", required: true },
      area_code: { type: "string" },
    };

    const goods = filledFrom(params);
    expect(() => paramSpecToValidator(params, "purchase").parse(goods)).not.toThrow();
    expect(Object.keys(goods)).toEqual(["email", "area_code"]);
  });

  it("fills nothing where a card declared nothing", () => {
    expect(filledFrom(undefined)).toEqual({});
  });
});
