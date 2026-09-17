import { describe, expect, it } from "vitest";

import { migrationModeFromArgs } from "./migrate";

describe("scanner migration mode", () => {
  it("has one fixed additive identity preflight and no arbitrary version knob", () => {
    expect(migrationModeFromArgs([])).toBe("full");
    expect(migrationModeFromArgs(["--identity-preflight"])).toBe(
      "identity-preflight",
    );
    expect(() => migrationModeFromArgs(["--to", "0016"])).toThrow(/usage/);
    expect(() =>
      migrationModeFromArgs(["--identity-preflight", "0015"]),
    ).toThrow(/usage/);
  });
});
