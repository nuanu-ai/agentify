/**
 * The import screen over the one list the HTTP tests cannot produce.
 *
 * A gateway that is not there refuses nothing, and a gateway that is there
 * refuses only what its rules refuse: one import in the HTTP tests gives a page
 * with either kind of stopped product, never both, because the harness's
 * gateway is up or gone for the whole import. The page a merchant reads
 * after a bad afternoon has both, and the promise it has to keep is that the
 * two are told apart — the product they can repair in their shop under the
 * door's own sentence, and the product nobody read under what came back
 * instead. The screen is a pure function of the outcomes, so the list is built
 * here by hand, in the shapes the import handler makes.
 */

import { describe, expect, it } from "vitest";
import type { Viewer } from "./screens.js";
import { readable } from "./testing/html.js";
import { wooImportScreen } from "./woo-screens.js";

const SEEN_BY: Viewer = { base: "", mode: "sandbox", who: "dmitry@example.com", confirmed: true };

describe("what the import screen says about a product the door never answered about", () => {
  it("lists it apart from a refused product, counts it apart, and sends nobody to their shop for it", () => {
    const html = wooImportScreen(SEEN_BY, {
      shopUrl: "https://shop.example.com",
      outcomes: [
        { id: "11", title: "Canvas tote bag", published: "item_1" },
        {
          id: "12",
          title: "Абонемент на месяц",
          problems: [
            "description: this description is 856 characters and a listing carries at most 500",
          ],
        },
        { id: "10", title: "Access code", failed: "the gateway could not be reached" },
      ],
      skipped: [],
    });
    const text = readable(html);

    expect(text).toContain("1 product published");
    expect(text).toContain("1 refused");
    expect(text).toContain("1 got no verdict");

    // The unanswered product stands under its own heading and nowhere else,
    // after the refused one and its invitation to change the shop, and that
    // invitation is not repeated over it.
    const unanswered = text.indexOf("No verdict");
    expect(unanswered).toBeGreaterThan(-1);
    const before = text.slice(0, unanswered);
    const after = text.slice(unanswered);
    expect(before).toContain("Абонемент на месяц");
    expect(before).toContain("in your shop and import again");
    expect(before).not.toContain("Access code");
    expect(after).toContain("Access code");
    expect(after).toContain("the gateway could not be reached");
    expect(after).not.toContain("Абонемент на месяц");
    expect(after).not.toContain("in your shop and import again");
  });
});
