/**
 * Two promises the page makes in its own markup. The one claim on these pages
 * that is about money: the stand signs real payments, the only thing here that
 * names an environment is the prefix of the key somebody typed, and the page
 * has to keep three answers apart — real money, test money, and not knowing.
 * That sentence is the promise, so the sentence is what those check. And a
 * paused order's Release button, which has to post back the very order it is
 * drawn beside.
 */

import { describe, expect, it } from "vitest";
import { type PageState, renderPage } from "./stand-page.js";

const A_CONNECTED_PAGE: PageState = {
  tab: "agent",
  address: "http://localhost:8080",
  keyEnvironment: null,
  stopped: null,
  said: null,
  entries: [],
  standing: { order: "deliver", quote: "price", held: 0, pauseAt: "none" },
  cards: [],
  selling: "open",
  cardDraft: "{}",
  publicItems: [],
  publicItemsRead: false,
  chosen: null,
  paramsDraft: "{}",
  exchange: null,
  moods: {
    order: "deliver",
    quote: "price",
    deliverAfterMs: 1_000,
    refusal: { code: "cannot_fulfill", message: "not this time" },
    price: { amount: "1.00", currency: "USD" },
  },
  goodsDraft: "",
  held: [],
  paused: [],
  stand: { pid: 4242, records: null },
  owed: [],
  orders: [],
  ordersRead: false,
  receipts: [],
  receiptsRead: false,
};

const connected = (keyEnvironment: PageState["keyEnvironment"]): string =>
  renderPage({ ...A_CONNECTED_PAGE, keyEnvironment });

describe("the page a connected operator reads", () => {
  it("warns that a purchase spends real money, and only for a live key", () => {
    expect(connected("live")).toContain("real money");
    expect(connected("test")).not.toContain("real money");
    expect(connected(null)).not.toContain("real money");
  });

  it("says it cannot tell, rather than picking a side, for a key naming neither", () => {
    const page = connected(null);

    expect(page).toContain("cannot say whether money on this gateway is real");
    // "I do not know" has to stay distinguishable from "I know there is none":
    // a page that quietly borrowed the test wording would tell an operator
    // their payments are pretend on a gateway nobody has vouched for.
    expect(page).not.toContain("test funds");
  });
});

/** Undoes the page's escaping of one attribute value. */
const unescaped = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** What each form on a page posts in its hidden fields, one record per form. */
const hiddenFieldsOfEachForm = (page: string): Record<string, string>[] =>
  page
    .split("<form")
    .slice(1)
    .map((form) =>
      Object.fromEntries(
        [
          ...form
            .slice(0, form.indexOf("</form>"))
            .matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g),
        ].map(([, name = "", value = ""]) => [unescaped(name), unescaped(value)]),
      ),
    );

describe("a paused order on the Orders tab", () => {
  it("is drawn with a Release form that posts its own identifier back", () => {
    // The promise: pressing Release lets go of the order it is drawn beside
    // and of no other. An identifier may carry any printable character, so
    // the form has to post it back exactly as the stand holds it.
    const id = `order "quoted" & <angled> 'too'`;
    const page = renderPage({
      ...A_CONNECTED_PAGE,
      tab: "orders",
      paused: [{ id, merchantItemId: "the-item-ordered", phase: "answer_ready", since: 0 }],
    });

    const releasing = hiddenFieldsOfEachForm(page).filter(
      (fields) => fields.action === "release_pause",
    );

    expect(releasing).toEqual([{ action: "release_pause", order_id: id }]);
  });
});
