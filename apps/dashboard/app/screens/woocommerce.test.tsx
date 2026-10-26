// @vitest-environment jsdom

/**
 * The WooCommerce screens drawn as the server sends them, from views built by
 * the same functions the server half calls, and alive in a document where the
 * application moves between them.
 *
 * One HTTP import gives either kind of stopped product, never both, because the
 * harness's gateway is up or gone for the whole import. The page must tell the
 * two apart (a product repairable in the shop under the gateway's own sentence,
 * and a product nobody read), so the list is built here by hand in the shapes
 * the import makes.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/ui/surface";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { formTo, readable } from "../../src/testing/html.js";
import type { Viewer } from "../../src/viewer.js";
import {
  type Held,
  type ShopAnswer,
  type ShopRead,
  wooImportView,
  wooShopView,
} from "../../src/woo-views.js";
import { SITE_IN_SETTINGS } from "../../src/words.js";
import type { Chrome } from "../answer.js";
import { WooImportScreen, WooPage, WooShopScreen } from "./woocommerce.js";

afterEach(() => {
  cleanup();
});

const SEEN_BY: Viewer = {
  base: "",
  mode: "sandbox",
  who: "owner@example.com",
  confirmed: true,
  sellerName: "Their own shop",
};

const SHOP = "https://shop.example.com";

/** Inside the gate, as the screens are, so a form that posts knows its address. */
const served = (screen: () => ReactElement): string => {
  const Stub = createRoutesStub([
    { id: "routes/gate", path: "/", children: [{ path: "page", Component: screen }] },
  ]);
  return renderToString(
    <Stub
      initialEntries={["/page"]}
      hydrationData={{ loaderData: { "routes/gate": { who: SEEN_BY.who } } }}
    />,
  );
};

const shopPage = (read: Partial<ShopRead>, answer: ShopAnswer = {}): string =>
  served(() => (
    <WooShopScreen
      view={wooShopView(
        { state: { kind: "none" }, through: "api", codeProducts: 0, unset: [], ...read },
        answer,
      )}
      base=""
    />
  ));

const CONNECTED: ShopRead["state"] = {
  kind: "connected",
  shop: { shopUrl: SHOP, permissions: "read_write", connectedAt: new Date("2026-10-12T09:00:00Z") },
};

/** One form of the page, read apart from the rest of it. */
const formOf = (html: string, action: string): string =>
  new RegExp(`<form[^>]*action="${action}"[^>]*>[\\s\\S]*?</form>`).exec(html)?.[0] ?? "";

/**
 * The panel or the disclosure a form stands in, which is where what its last
 * press came to is said.
 */
const blockOf = (html: string, action: string): string => {
  const at = html.indexOf(`action="${action}"`);
  if (at === -1) return "";
  // An identifier folds its long form into a disclosure of its own, which is
  // no block.
  const opened = [
    ...html.slice(0, at).matchAll(/<(section|details)\b(?![^>]*ident-whole)[^>]*>/g),
  ].at(-1);
  if (opened === undefined) return "";
  return html.slice(opened.index, html.indexOf(`</${opened[1]}>`, at));
};

/** The invitation to change the shop, which must not stand over a product nobody read. */
const SENT_TO_THE_SHOP = /change these in your shop/i;

const imported = (
  outcomes: Parameters<typeof wooImportView>[1],
  skipped: Parameters<typeof wooImportView>[2] = [],
) => served(() => <WooImportScreen view={wooImportView(SHOP, outcomes, skipped)} base="" />);

describe("what the import screen says about a product the door never answered about", () => {
  it("lists it apart from a refused product, counts it apart, and sends nobody to their shop for it", () => {
    const text = readable(
      imported([
        { id: "11", title: "Canvas tote bag", published: "item_1" },
        {
          id: "12",
          title: "Абонемент на месяц",
          problems: [
            "Description: this description is 856 characters and a listing carries at most 500",
          ],
        },
        { id: "10", title: "Access code", failed: true },
      ]),
    );

    expect(text).toContain("To fix 1");
    expect(text).toContain("No verdict 1");
    expect(text).toContain("Published 1");

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
    expect(after).toMatch(/don't know if these were published/);
    expect(after).not.toContain("Абонемент на месяц");
    expect(after).not.toMatch(SENT_TO_THE_SHOP);
  });

  it("keeps an operator-approval finding among the gateway's escaped publication reasons", () => {
    const finding =
      "operator approval: ask Agentify to approve this seller <script>alert(1)</script>";
    const html = imported([
      {
        id: "12",
        title: "Monthly membership",
        problems: ["seller name: choose one in the dashboard", finding],
      },
    ]);
    const text = readable(html);

    expect(text).toContain("seller name: choose one in the dashboard");
    expect(text).toContain(finding);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("the order of what an import did", () => {
  it("puts what the merchant can put right first, and folds the products that went through last", () => {
    const html = imported(
      [
        { id: "11", title: "Canvas tote bag", published: "item_1" },
        { id: "12", title: "Coffee beans, one kilogram", problems: [SITE_IN_SETTINGS] },
      ],
      [
        {
          id: "13",
          title: "Monthly membership",
          why: "Variable products aren't supported.",
          fixable: false,
        },
        {
          id: "14",
          title: "Batik sarong",
          why: "The product is not published in the shop.",
          fixable: true,
        },
      ],
    );
    const text = readable(html);

    const toFix = text.indexOf("To fix 2");
    const unsupported = text.indexOf("Not supported 1");
    const published = text.indexOf("Published 1");
    expect(toFix).toBeGreaterThan(-1);
    expect(text.indexOf("Batik sarong")).toBeGreaterThan(toFix);
    expect(text.indexOf("Batik sarong")).toBeLessThan(unsupported);
    expect(unsupported).toBeLessThan(published);
    // Folded: the published list is drawn closed.
    expect(html).toMatch(/<details class="[^"]*"><summary>[^<]*<\/summary>[\s\S]*Canvas tote bag/);
  });

  it("says a length is counted without formatting only where a length was refused", () => {
    const measured = readable(
      imported([
        {
          id: "12",
          title: "Handwoven table runner",
          problems: ["Description: this description is 856 characters"],
          tooLong: true,
        },
      ]),
    );
    const other = readable(
      imported([{ id: "12", title: "Coffee beans", problems: [SITE_IN_SETTINGS] }]),
    );

    expect(measured).toContain("without formatting");
    expect(other).not.toContain("without formatting");
  });
});

describe("what the import screen offers beside a product it could not publish", () => {
  it("offers Settings beside a parcel held for want of the shop's site, and nothing beside one the shop must change", () => {
    const html = imported([
      { id: "12", title: "Coffee beans, one kilogram", problems: [SITE_IN_SETTINGS] },
      {
        id: "13",
        title: "Canvas tote bag",
        problems: [
          "Description: this description is 856 characters and a listing carries at most 500",
        ],
      },
    ]);

    expect([...html.matchAll(/href="\/settings"/g)]).toHaveLength(1);
    expect(html.indexOf('href="/settings"')).toBeGreaterThan(html.indexOf("Coffee beans"));
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf("Canvas tote bag"));
  });
});

describe("where the shop screen says why a press was refused", () => {
  // In the panel of the control that was pressed, so the merchant reads the
  // refusal where they look next rather than under a form they did not touch.
  const problemsIn = (block: string): string[] =>
    [...block.matchAll(/<p class="problem"[^>]*>([\s\S]*?)<\/p>/g)].map(([, said = ""]) =>
      readable(said),
    );

  it("says a refused address under its box, keeping what was typed", () => {
    const html = shopPage(
      {},
      { addressProblem: "Enter your site's root address: https://x.y", typed: "x.y/shop" },
    );
    const form = formOf(html, "/woocommerce/connect");
    const box = /<input[^>]*name="shop_url"[^>]*>/.exec(form)?.[0] ?? "";
    const line = /aria-describedby="([^"]+)"/.exec(box)?.[1];

    expect(box).toContain('aria-invalid="true"');
    expect(box).toContain('value="x.y/shop"');
    const said = new RegExp(`id="${line}"[^>]*>([^<]*)<`).exec(form)?.[1] ?? "";
    expect(readable(said)).toBe("Enter your site's root address: https://x.y");
  });

  it("says a refused Connect at the top of its panel when the address is not what was wrong", () => {
    const html = shopPage({}, { problem: "Your shop did not show its approval screen." });

    expect(problemsIn(blockOf(html, "/woocommerce/connect"))).toStrictEqual([
      "Your shop did not show its approval screen.",
    ]);
  });

  it("says what the shop answered to an import in the import's panel, not beside the way out", () => {
    const html = shopPage(
      { state: CONNECTED, through: "woocommerce" },
      { importing: "Your shop answered 403: Forbidden" },
    );

    expect(problemsIn(blockOf(html, "/woocommerce/import"))).toStrictEqual([
      "Your shop answered 403: Forbidden",
    ]);
    expect(problemsIn(blockOf(html, "/woocommerce/disconnect"))).toStrictEqual([]);
  });

  it("says a refused way back beside the way back, whether or not a shop is connected", () => {
    const leaving = "An order still waits on the shop: ord_1.";
    for (const state of [CONNECTED, { kind: "none" } as const]) {
      const html = shopPage({ state, through: "woocommerce" }, { leaving });

      expect(problemsIn(blockOf(html, "/woocommerce/disconnect")), state.kind).toStrictEqual([
        leaving,
      ]);
    }
  });

  it("says a refused switch beside the switch", () => {
    const switching = "An order still waits on your code: ord_2.";
    const html = shopPage({ state: CONNECTED, through: "api" }, { switching });

    expect(problemsIn(blockOf(html, "/woocommerce/switch"))).toStrictEqual([switching]);
  });

  const held = (
    to: Held["to"],
    orders: readonly string[],
    more: Partial<Held> = {},
  ): { readonly held: Held } => ({
    held: { to, orders, quick: false, parcels: false, ...more },
  });
  const waiting = (count: number) =>
    Array.from({ length: count }, (_, at) => `ord_${at}0f3c9a1b2d4e6f8a7b9c`);

  it("names each order that holds a switch with a button copying it whole, counts the ones it leaves out, and leads to them all", () => {
    const orders = waiting(7);
    const block = blockOf(
      shopPage({ state: CONNECTED, through: "api" }, { switching: held("woocommerce", orders) }),
      "/woocommerce/switch",
    );

    expect([...block.matchAll(/aria-label="Copy the whole order ID [^"]+"/g)]).toHaveLength(5);
    for (const id of orders.slice(0, 5)) expect(readable(block)).toContain(id);
    for (const id of orders.slice(5)) expect(readable(block)).not.toContain(id);
    expect(readable(block)).toMatch(/\b2 more\b/);
    expect(block).toContain('href="/orders?show=open"');
  });

  it("names five waiting orders without saying there are more", () => {
    const block = blockOf(
      shopPage({ state: CONNECTED, through: "woocommerce" }, { leaving: held("api", waiting(5)) }),
      "/woocommerce/disconnect",
    );

    expect([...block.matchAll(/aria-label="Copy the whole order ID [^"]+"/g)]).toHaveLength(5);
    expect(readable(block)).not.toMatch(/\bmore\b/);
  });

  it("tells purchases about to lapse apart from goods owed: try again in a minute, naming none", () => {
    const block = blockOf(
      shopPage({}, { problem: held("woocommerce", waiting(3), { quick: true }) }),
      "/woocommerce/connect",
    );

    expect(readable(block)).toMatch(/try again/i);
    expect(readable(block)).toMatch(/within a minute/);
    expect(block).not.toMatch(/aria-label="Copy the whole order ID/);
    expect(readable(block)).not.toMatch(/pause/i);
  });

  it("says how a parcel ends where one holds the way out", () => {
    const parcel = readable(
      blockOf(
        shopPage(
          { state: CONNECTED, through: "woocommerce" },
          { leaving: held("api", waiting(2), { parcels: true }) },
        ),
        "/woocommerce/disconnect",
      ),
    );
    const none = readable(
      blockOf(
        shopPage(
          { state: CONNECTED, through: "woocommerce" },
          { leaving: held("api", waiting(2)) },
        ),
        "/woocommerce/disconnect",
      ),
    );

    expect(parcel).toContain("Completed");
    expect(parcel).toContain("seven days");
    expect(none).not.toContain("Completed in WooCommerce, or");
  });

  it("says a refused Connect again beside it when the shop granted read alone", () => {
    const html = shopPage(
      {
        state: {
          kind: "connected",
          shop: {
            shopUrl: SHOP,
            permissions: "read",
            connectedAt: new Date("2026-10-12T09:00:00Z"),
          },
        },
        through: "woocommerce",
      },
      { problem: "Your shop did not show its approval screen." },
    );

    expect(readable(blockOf(html, "/woocommerce/connect"))).toContain(
      "Your shop did not show its approval screen.",
    );
  });

  it("draws what it was given as text, never as markup", () => {
    const html = shopPage(
      { state: CONNECTED, through: "woocommerce" },
      { importing: "Your shop answered <script>alert(1)</script>" },
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(readable(html)).toContain("Your shop answered <script>alert(1)</script>");
  });
});

describe("what the shop screen holds before it is pressed", () => {
  const importButton = (html: string): string =>
    /<button[^>]*>Import products<\/button>/.exec(formOf(html, "/woocommerce/import"))?.[0] ?? "";

  it("holds Import, naming the setting and where to set it, while every product would be refused", () => {
    const html = shopPage({
      state: CONNECTED,
      through: "woocommerce",
      unset: ["no_payout_wallet"],
    });
    const form = formOf(html, "/woocommerce/import");

    expect(importButton(html)).toMatch(/\bdisabled\b/);
    expect(readable(form)).toContain("payout wallet");
    expect(form).toContain('href="/settings"');
  });

  it("holds Import until a shop priced in another currency has its rate", () => {
    const html = shopPage({
      state: CONNECTED,
      through: "woocommerce",
      rate: {
        currency: { code: "IDR", decimals: 0 },
        current: null,
        reference: { ok: false, listed: null },
      },
    });

    expect(importButton(html)).toMatch(/\bdisabled\b/);
    expect(readable(formOf(html, "/woocommerce/import"))).toContain("exchange rate");
  });

  it("says a shop in a currency Coinbase gives no rate for cannot sell, and asks for no rate", () => {
    const html = shopPage({
      state: CONNECTED,
      through: "woocommerce",
      rate: {
        currency: { code: "XAF", decimals: 0 },
        current: null,
        reference: { ok: false, listed: false },
      },
    });
    const held = readable(formOf(html, "/woocommerce/import"));

    expect(importButton(html)).toMatch(/\bdisabled\b/);
    expect(held).toMatch(/can't sell/);
    expect(held).not.toMatch(/Set the exchange rate/);
  });

  it("offers Import where nothing stands in its way, and where what stands could not be read", () => {
    for (const unset of [[], null] as const) {
      const html = shopPage({ state: CONNECTED, through: "woocommerce", unset });

      expect(importButton(html), String(unset)).not.toMatch(/\bdisabled\b/);
    }
  });

  it("offers the switch and no Import while the merchant sells through their own code", () => {
    const html = shopPage({ state: CONNECTED, through: "api" });

    expect(formTo(html, "post", "/woocommerce/switch")).toBeDefined();
    expect(formTo(html, "post", "/woocommerce/import")).toBeUndefined();
  });

  it("asks before it disconnects a connected shop: every press stands inside a closed disclosure", () => {
    for (const through of ["woocommerce", "api"] as const) {
      const page = new DOMParser().parseFromString(
        shopPage({ state: CONNECTED, through }),
        "text/html",
      );
      const forms = [...page.querySelectorAll('form[action="/woocommerce/disconnect"]')];

      expect(forms, through).not.toHaveLength(0);
      for (const form of forms) {
        const disclosure = form.closest("details");
        expect(disclosure, through).not.toBeNull();
        expect(disclosure?.open, through).toBe(false);
      }
    }
  });

  it("says a read-only grant as a warning rather than as connected", () => {
    const text = readable(
      shopPage({
        state: {
          kind: "connected",
          shop: { shopUrl: SHOP, permissions: "read", connectedAt: new Date() },
        },
        through: "woocommerce",
      }),
    );

    expect(text).toContain("Read-only access");
    expect(text).not.toContain("Connected");
  });
});

describe("what the shop screen says a switch does to the code's products", () => {
  const connectPanel = (codeProducts: number | null) =>
    readable(blockOf(shopPage({ through: "api", codeProducts }), "/woocommerce/connect"));

  it("says it only where the code published some, with how many", () => {
    expect(connectPanel(12)).toContain("the 12 products your code published go off sale");
    expect(connectPanel(1)).toContain("the product your code published goes off sale");
    expect(connectPanel(0)).not.toMatch(/off sale/);
  });

  it("says it without a number where the products could not be counted, never as none", () => {
    expect(connectPanel(null)).toContain("the products your code published go off sale");
  });

  it("says the code's products come back paused, where there are some, on the way back", () => {
    const back = (codeProducts: number) =>
      readable(
        blockOf(
          shopPage({ state: { kind: "none" }, through: "woocommerce", codeProducts }),
          "/woocommerce/disconnect",
        ),
      );

    expect(back(12)).toMatch(/12 products your code published come back paused/);
    expect(back(0)).not.toMatch(/come back/);
  });
});

describe("what the shop screen offers while no keys are here", () => {
  it("offers to check again while the fifteen minutes run, with the address in the box", () => {
    const html = shopPage({
      state: { kind: "waiting", shopUrl: SHOP, startedMinutesAgo: 4 },
      through: "woocommerce",
    });

    expect(readable(html)).toContain("Check again");
    expect(formTo(html, "post", "/woocommerce/connect")).toBeDefined();
    expect(formOf(html, "/woocommerce/connect")).toContain(`value="${SHOP}"`);
  });

  it("offers only Connect again once they ran out, and still keeps the address", () => {
    const html = shopPage({ state: { kind: "unanswered", shopUrl: SHOP }, through: "api" });

    expect(readable(html)).not.toContain("Check again");
    expect(readable(html)).toContain("No keys came");
    expect(formOf(html, "/woocommerce/connect")).toContain(`value="${SHOP}"`);
  });

  it("puts Connect before the way back to the code, which it never stands above", () => {
    const html = shopPage({
      state: { kind: "waiting", shopUrl: SHOP, startedMinutesAgo: 4 },
      through: "woocommerce",
    });

    expect(html.indexOf('action="/woocommerce/connect"')).toBeGreaterThan(-1);
    expect(html.indexOf('action="/woocommerce/connect"')).toBeLessThan(
      html.indexOf('action="/woocommerce/disconnect"'),
    );
  });
});

describe("a press's address reached inside the application", () => {
  // Back or Forward from a section the application drew returns to the
  // press's address without its answer, which React Router does not keep.
  it("leads to the shop screen rather than to a page saying the dashboard is broken", async () => {
    const chrome: Chrome = {
      base: "",
      surface: {
        attribute: SURFACE_MARKER_ATTRIBUTE,
        mode: "sandbox",
        words: SURFACE_WORDS.sandbox,
      },
    };
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        children: [
          {
            id: "routes/gate",
            children: [
              { path: "woocommerce/import", Component: () => <WooPage view={undefined} /> },
              { path: "woocommerce", Component: () => <p>The shop screen</p> },
            ],
          },
        ],
      },
    ]);

    const page = render(
      <Stub
        initialEntries={["/woocommerce/import"]}
        hydrationData={{ loaderData: { root: chrome, "routes/gate": { who: SEEN_BY.who } } }}
      />,
    );

    expect(await page.findByText("The shop screen")).toBeDefined();
  });
});
