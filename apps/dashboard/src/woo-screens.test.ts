/**
 * One HTTP import gives either kind of stopped product, never both, because the
 * harness's gateway is up or gone for the whole import. The page must tell the
 * two apart (a product repairable in the shop under the gateway's own sentence,
 * and a product nobody read), so the list is built here by hand in the shapes
 * the import handler makes.
 */

import { describe, expect, it } from "vitest";
import type { Viewer } from "./screens.js";
import { readable } from "./testing/html.js";
import { wooImportScreen } from "./woo-screens.js";

const SEEN_BY: Viewer = { base: "", mode: "sandbox", who: "owner@example.com", confirmed: true };

/**
 * Not `/import again/i`: the "No verdict" block reads "Import again later",
 * which would match where the invitation must not appear.
 */
const SENT_TO_THE_SHOP = /shop and import again/i;

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

    // The unanswered product stands under its own heading only, after the
    // refused one, and the invitation to change the shop is not repeated over
    // it.
    const unanswered = text.indexOf("No verdict");
    expect(unanswered).toBeGreaterThan(-1);
    const before = text.slice(0, unanswered);
    const after = text.slice(unanswered);
    expect(before).toContain("Абонемент на месяц");
    expect(before).toMatch(SENT_TO_THE_SHOP);
    expect(before).not.toContain("Access code");
    expect(after).toContain("Access code");
    expect(after).toContain("the gateway could not be reached");
    expect(after).not.toContain("Абонемент на месяц");
    expect(after).not.toMatch(SENT_TO_THE_SHOP);
  });

  it("keeps an operator-approval finding among the gateway's escaped publication reasons", () => {
    const finding =
      "operator approval: ask Agentify to approve this seller <script>alert(1)</script>";
    const html = wooImportScreen(SEEN_BY, {
      shopUrl: "https://shop.example.com",
      outcomes: [
        {
          id: "12",
          title: "Monthly membership",
          problems: ["seller name: choose one in the dashboard", finding],
        },
      ],
      skipped: [],
    });
    const text = readable(html);

    expect(text).toContain("seller name: choose one in the dashboard");
    expect(text).toContain(finding);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
