import { describe, expect, it } from "vitest";

import { refuseArguments } from "./migrate.js";

describe("the scanner migration command", () => {
  it("applies every pending migration and refuses any argument", () => {
    expect(() => refuseArguments([])).not.toThrow();
    expect(() => refuseArguments(["--to", "0016"])).toThrow(/takes no arguments/);
    expect(() => refuseArguments(["--dry-run"])).toThrow(/--dry-run/);
  });
});
