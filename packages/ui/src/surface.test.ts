/**
 * The words a test stack says about itself. If this fails, a test page claims
 * more than its chain vouches for.
 */

import { describe, expect, it } from "vitest";
import { SURFACE_WORDS } from "./surface.js";
import { CHANNEL_NAMES } from "./workspace-view.js";

describe("SURFACE_WORDS", () => {
  it("claims on a test page only what the chain vouches for, not that anything settles", () => {
    // A test mode is any facilitator on a test chain, including a local model
    // that settles nothing; that the money is not real is all the chain says.
    expect(SURFACE_WORDS.test).toMatch(/test funds/);
    expect(SURFACE_WORDS.test).not.toMatch(/settle/i);
  });

  it("names each stack as the operator's workspace names it", () => {
    for (const mode of ["sandbox", "test"] as const) {
      expect(SURFACE_WORDS[mode]?.startsWith(`${CHANNEL_NAMES[mode]}.`)).toBe(true);
    }
  });
});
