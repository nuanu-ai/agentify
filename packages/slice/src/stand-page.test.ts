/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// @vitest-environment jsdom
/**
 * Two promises the page makes in its own markup. The one claim on these pages
 * that is about money: the stand signs real payments, the only thing here that
 * names an environment is the prefix of the key somebody typed, and the page
 * has to keep three answers apart — real money, test money, and not knowing.
 * That sentence is the promise, so the sentence is what those check. And a
 * paused order's row, whose Release button has to post back the very order it
 * is drawn beside and which has to say where that order stands.
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
    expect(notice(connected("live")).textContent).toMatch(/real money/i);
    expect(notice(connected("test")).textContent).toMatch(/test.*(?:USDC|money|fund)/i);
    expect(notice(connected("test")).textContent).not.toMatch(/real money/i);
    expect(notice(connected(null)).textContent).not.toMatch(/real money/i);
  });

  it("says it cannot tell, rather than picking a side, for a key naming neither", () => {
    const page = connected(null);

    expect(notice(page).textContent).toMatch(/(?:cannot|unknown|uncertain|not know).*money/i);
    // "I do not know" has to stay distinguishable from "I know there is none":
    // a page that quietly borrowed the test wording would tell an operator
    // their payments are pretend on a gateway nobody has vouched for.
    expect(notice(page).textContent).not.toMatch(/test funds|live key|test key/i);
  });
});

const documentOf = (html: string): Document => new DOMParser().parseFromString(html, "text/html");
const notice = (html: string): HTMLElement => {
  const element = documentOf(html).querySelector<HTMLElement>(".surface");
  expect(element).not.toBeNull();
  if (element === null) throw new Error("the connected environment has no visible notice");
  expect(element.closest("[hidden], [aria-hidden=true]")).toBeNull();
  expect(element.style.display).not.toBe("none");
  return element;
};

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

    const forms = [...documentOf(page).querySelectorAll("form")].filter(
      (form) => new FormData(form).get("action") === "release_pause",
    );
    expect(forms).toHaveLength(1);
    const form = forms[0];
    if (form === undefined) throw new Error("no release form");
    expect(form.method).toBe("post");
    expect(form.getAttribute("action")).toBeNull();
    expect(Object.fromEntries(new FormData(form).entries())).toEqual({
      action: "release_pause",
      order_id: id,
    });
  });

  it("says the point it is paused at, and whether its answer is on disk yet", () => {
    // The promise: the row is what a tester reads before `kill -9`. A row
    // naming the other point, or calling an answer recorded on a stand that
    // keeps no records, sends them to crash in a phase they did not mean.
    const paused: PageState["paused"] = [
      { id: "paused-as-it-arrived", merchantItemId: "the-item", phase: "arrival", since: 0 },
      { id: "paused-with-its-answer", merchantItemId: "the-item", phase: "answer_ready", since: 0 },
    ];
    const rowsOnAStandKeeping = (records: string | null): string[] =>
      [
        ...documentOf(
          renderPage({ ...A_CONNECTED_PAGE, tab: "orders", paused, stand: { pid: 4242, records } }),
        ).querySelectorAll("tr"),
      ]
        .filter((row) => row.querySelector('input[value="release_pause"]') !== null)
        .map((row) => row.cells[1]?.textContent?.trim() ?? "");

    expect(rowsOnAStandKeeping(null)).toEqual([
      "arrived, nothing done yet",
      "answer ready, not sent",
    ]);
    expect(rowsOnAStandKeeping("/tmp/stand-records")).toEqual([
      "arrived, nothing done yet",
      "answer recorded, not sent",
    ]);
  });
});
