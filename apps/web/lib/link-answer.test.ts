import { describe, expect, it } from "vitest";

import { waitLabel } from "./link-answer";

describe("a wait on a button", () => {
  it("counts a wait down in the unit a person reads at a glance", () => {
    expect(waitLabel(40)).toBe("40s");
    expect(waitLabel(59)).toBe("59s");
    expect(waitLabel(60)).toBe("1m");
    expect(waitLabel(510)).toBe("9m");
  });
});
