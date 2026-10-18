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

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/core";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { formTo, readable } from "../../src/testing/html.js";
import type { Viewer } from "../../src/viewer.js";
import { type ShopAnswer, type ShopRead, wooImportView, wooShopView } from "../../src/woo-views.js";
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
        SEEN_BY,
        { state: { kind: "none" }, unset: [], through: "api", ...read },
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
 * Not `/import again/i`: the "No verdict" block reads "Import again later",
 * which would match where the invitation must not appear.
 */
const SENT_TO_THE_SHOP = /shop and import again/i;

describe("what the import screen says about a product the door never answered about", () => {
  it("lists it apart from a refused product, counts it apart, and sends nobody to their shop for it", () => {
    const html = renderToString(
      <WooImportScreen
        view={wooImportView(
          SHOP,
          [
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
          [],
        )}
        base=""
      />,
    );
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
    const html = renderToString(
      <WooImportScreen
        view={wooImportView(
          SHOP,
          [
            {
              id: "12",
              title: "Monthly membership",
              problems: ["seller name: choose one in the dashboard", finding],
            },
          ],
          [],
        )}
        base=""
      />,
    );
    const text = readable(html);

    expect(text).toContain("seller name: choose one in the dashboard");
    expect(text).toContain(finding);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("what the import screen offers beside a product it could not publish", () => {
  it("offers Settings beside a parcel held for want of the shop's site, and nothing beside one the shop must change", () => {
    const html = served(() => (
      <WooImportScreen
        view={wooImportView(
          SHOP,
          [
            { id: "12", title: "Coffee beans, one kilogram", problems: [SITE_IN_SETTINGS] },
            {
              id: "13",
              title: "Canvas tote bag",
              problems: [
                "description: this description is 856 characters and a listing carries at most 500",
              ],
            },
          ],
          [],
        )}
        base=""
      />
    ));

    expect([...html.matchAll(/href="\/settings"/g)]).toHaveLength(1);
    expect(html.indexOf('href="/settings"')).toBeGreaterThan(html.indexOf("Coffee beans"));
    expect(html.indexOf('href="/settings"')).toBeLessThan(html.indexOf("Canvas tote bag"));
  });
});

describe("where the shop screen says why a press was refused", () => {
  // Beside the control that was pressed, so the merchant reads the refusal
  // where they look next rather than under a form they did not touch.
  const problemsIn = (form: string): string[] =>
    [...form.matchAll(/<p class="problem"[^>]*>([\s\S]*?)<\/p>/g)].map(([, said = ""]) =>
      readable(said),
    );

  it("says a refused Connect under the box, keeping what was typed", () => {
    const html = shopPage({}, { problem: "Use the address of the shop itself.", typed: "x.y" });

    expect(problemsIn(formOf(html, "/woocommerce/connect"))).toStrictEqual([
      "Use the address of the shop itself.",
    ]);
    expect(formOf(html, "/woocommerce/connect")).toContain('value="x.y"');
  });

  it("says what the shop answered under the connected shop, not under a form", () => {
    const html = shopPage(
      { state: CONNECTED, through: "woocommerce" },
      { problem: "Your shop answered 403: Forbidden" },
    );

    expect(readable(html)).toContain("Your shop answered 403: Forbidden");
    expect(problemsIn(formOf(html, "/woocommerce/import"))).toStrictEqual([]);
    expect(problemsIn(formOf(html, "/woocommerce/disconnect"))).toStrictEqual([]);
  });

  it("says a refused way back beside the way back, whether or not a shop is connected", () => {
    const leaving = "An order still waits on the shop: ord_1.";
    for (const state of [CONNECTED, { kind: "none" } as const]) {
      const html = shopPage({ state, through: "woocommerce" }, { leaving });

      expect(problemsIn(formOf(html, "/woocommerce/disconnect")), state.kind).toStrictEqual([
        leaving,
      ]);
    }
  });

  it("says a refused switch beside the switch", () => {
    const switching = "An order still waits on your code: ord_2.";
    const html = shopPage({ state: CONNECTED, through: "api" }, { switching });

    expect(problemsIn(formOf(html, "/woocommerce/switch"))).toStrictEqual([switching]);
  });

  it("draws what it was given as text, never as markup", () => {
    const html = shopPage(
      { state: CONNECTED, through: "woocommerce" },
      { problem: "Your shop answered <script>alert(1)</script>" },
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(readable(html)).toContain("Your shop answered <script>alert(1)</script>");
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
    expect(readable(html)).toContain("did not arrive");
    expect(formOf(html, "/woocommerce/connect")).toContain(`value="${SHOP}"`);
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
