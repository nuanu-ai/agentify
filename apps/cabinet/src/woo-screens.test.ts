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
 *
 * The shop screen on the live channel is here for the same kind of reason: the
 * HTTP suite stands up the sandbox and the test channel and not live, and the
 * line beside Import is a pure function of the channel and what is unset.
 */

import { describe, expect, it } from "vitest";
import type { Viewer } from "./screens.js";
import { importFormOf, readable } from "./testing/html.js";
import { type Unset, type WooView, wooImportScreen, wooScreen } from "./woo-screens.js";

const SEEN_BY: Viewer = { base: "", mode: "sandbox", who: "dmitry@example.com", confirmed: true };

/**
 * The invitation to go and repair something, found by its shape rather than by
 * a whole sentence nobody is testing.
 *
 * It used to be spelled out in full, so a copy edit to a sentence this test has
 * no opinion about would have broken a test about the order of two sections.
 * It cannot be shortened all the way to `/import again/i`, which is what a
 * first reading suggests: the "No verdict" block's own line reads "Import again
 * later", and that regex would then match in the half of the page where the
 * invitation must not appear, failing on a page that is correct.
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

    // The unanswered product stands under its own heading and nowhere else,
    // after the refused one and its invitation to change the shop, and that
    // invitation is not repeated over it.
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
          problems: ["seller name: choose one in the cabinet", finding],
        },
      ],
      skipped: [],
    });
    const text = readable(html);

    expect(text).toContain("seller name: choose one in the cabinet");
    expect(text).toContain(finding);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("what the Import line promises about the live channel", () => {
  // Selling live needs the operator's approval as well as a name and a wallet,
  // and no route tells the cabinet whether a merchant holds it. A live line
  // that sent a merchant to Settings and back to Import as though that were
  // enough would promise what the page cannot know. On the test channel
  // nobody approves anybody, and naming an approval there would send a
  // merchant looking for something that does not exist.
  const lineOn = (mode: Viewer["mode"], said: Pick<WooView, "unset" | "refused">): string =>
    readable(
      importFormOf(
        wooScreen(
          { ...SEEN_BY, mode },
          {
            state: {
              kind: "connected",
              shop: {
                shopUrl: "https://shop.example.com",
                permissions: "read_write",
                connectedAt: new Date("2026-09-25T12:00:00.000Z"),
              },
            },
            ...said,
          },
        ),
      ),
    );
  const unset: readonly Unset[] = ["payout_wallet"];

  it("names the approval beside what is unset on live, before the press and after it", () => {
    expect(lineOn("live", { unset })).toMatch(/approv/i);
    expect(lineOn("live", { unset, refused: unset })).toMatch(/approv/i);
  });

  it("names no approval on the test channel", () => {
    expect(lineOn("test", { unset })).toMatch(/wallet/i);
    expect(lineOn("test", { unset })).not.toMatch(/approv/i);
    expect(lineOn("test", { unset, refused: unset })).not.toMatch(/approv/i);
  });
});
