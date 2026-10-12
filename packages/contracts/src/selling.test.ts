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

  it("says in the exported document that leaving is not a heavier pause", () => {
    // Pausing lets open orders play out; leaving closes them and leaves the
    // merchant owing refunds. A reader of the exported document sees only
    // three strings, so the description has to say it.
    const description = toJsonSchemas().selling_state.description ?? "";

    expect(description).toContain("already accepted play out");
    expect(description).toContain("closed with them");
    expect(description).toContain("not reachable by pausing");
  });

  it("reaches the reader who has the exported document and nothing else", () => {
    const document = toJsonSchemas().selling_state;

    expect(document.enum).toStrictEqual([...SELLING_STATES]);
    expect(document.description ?? "").toContain("paused");
  });
});
