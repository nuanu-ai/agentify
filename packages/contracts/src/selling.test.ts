import { describe, expect, it } from "vitest";
import { toJsonSchemas } from "./index.js";
import { SELLING_STATES, SellingStateSchema } from "./selling.js";

describe("whether a merchant is taking new orders", () => {
  // The promise: the dashboard, the merchant's own tooling and the order
  // machine use one word for the same situation.
  it("carries the three words the order machine is given, and no others", () => {
    for (const state of ["open", "paused", "departed"]) {
      expect(SellingStateSchema.safeParse(state).success, state).toBe(true);
    }
    for (const state of ["stopped", "off", "OPEN", "closed", ""]) {
      expect(SellingStateSchema.safeParse(state).success, JSON.stringify(state)).toBe(false);
    }
  });

  it("reaches the reader who has the exported document and nothing else", () => {
    const document = toJsonSchemas().selling_state;

    expect(document.enum).toStrictEqual([...SELLING_STATES]);
  });
});
