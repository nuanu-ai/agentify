/**
 * What the pages still drawn as strings say about the stack, drawn from values
 * the contract's schemas would accept, so nothing is stubbed.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/core";
import { describe, expect, it } from "vitest";
import { page } from "./html.js";
import { readable } from "./testing/html.js";

describe("what a page says about the stack it belongs to", () => {
  it("carries the same marker on a signed-in page", () => {
    // Pages behind the sign-in must carry the stack label too.
    const html = page({
      base: "",
      who: "owner@example.com",
      confirmed: true,
      tab: "cards",
      title: "Cards",
      mode: "test",
      body: "<p>x</p>",
    });

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="test"`);
    expect(readable(html)).toContain(SURFACE_WORDS.test);
  });
});
