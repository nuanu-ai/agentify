import { describe, expect, it } from "vitest";

import { createUuidV7 } from "./ids.js";

describe("createUuidV7", () => {
  it("generates version 7 UUIDs", () => {
    expect(createUuidV7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
