// @vitest-environment jsdom

/**
 * The WooCommerce screens drawn as the server sends them, from views built by
 * the same functions the server half calls, and alive in a document where the
 * application moves between them.

 */

import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { presentShopJob } from "../../src/shop-job-presentation.js";
import { coinbaseAsRecorded } from "../../src/testing/coinbase.js";
import { formTo, readable } from "../../src/testing/html.js";
import type { Viewer } from "../../src/viewer.js";
import {
  type Held,
  heldBy,
  type ShopAnswer,
  type ShopRead,
  wooShopView,
} from "../../src/woo-views.js";
import { WooShopScreen } from "./woocommerce.js";

const SEEN_BY: Viewer = {
  base: "",
  mode: "sandbox",
  who: "owner@example.com",
  confirmed: true,
  sellerName: "Their own shop",
};

const SHOP = "https://shop.example.com";

/** Inside the gate, as the screens are, so a form that posts knows its address. */
const served = async (screen: () => ReactElement): Promise<string> => {
  const Stub = createRoutesStub([
    { id: "routes/gate", path: "/", children: [{ path: "page", Component: screen }] },
  ]);
  const { prelude } = await prerender(
    <Stub
      initialEntries={["/page"]}
      hydrationData={{ loaderData: { "routes/gate": { who: SEEN_BY.who } } }}
    />,
  );
  return new Response(prelude).text();
};

const shopPage = async (read: Partial<ShopRead>, answer: ShopAnswer = {}): Promise<string> =>
  await served(() => (
    <WooShopScreen
      view={{
        ...wooShopView(
          {
            state: { kind: "none" },
            through: "api",
            codeProducts: 0,
            unset: [],
            testMoney: true,
            ...read,
          },
          answer,
        ),
        job:
          read.state?.kind === "connected" && read.through === "woocommerce"
            ? presentShopJob({
                id: "checked-shop",
                shopHost: "shop.example.com",
                revision: 2,
                kind: "check",
                status: read.rate?.current === null ? "stopped" : "completed",
                stopCode: read.rate?.current === null ? "rate_required" : null,
                read: read.rate?.current === null ? 0 : 1,
                total: read.rate?.current === null ? null : 1,
                ready: read.rate?.current === null ? 0 : 1,
                published: 0,
                excluded: 0,
                publicationUnknown: null,
                currency: read.rate?.currency.code ?? "USD",
                when: { text: "30 Oct 2026" },
                why: null,
                current: true,
                groups: [],
              })
            : null,
      }}
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

describe("the Connect form's note about test purchases", () => {
  it("is drawn where a purchase is paid in test USDC, and not where the money is real", async () => {
    const note = 'role="note" aria-label="Test purchases"';

    expect(await shopPage({ testMoney: true })).toContain(note);
    expect(await shopPage({ testMoney: false })).not.toContain(note);
  });
});

describe("where the shop screen says why a press was refused", () => {
  // In the panel of the control that was pressed, so the merchant reads the
  // refusal where they look next rather than under a form they did not touch.
  const problemsIn = (block: string): string[] =>
    [...block.matchAll(/<p class="problem"[^>]*>([\s\S]*?)<\/p>/g)].map(([, said = ""]) =>
      readable(said),
    );

  it("says a refused address under its box, keeping what was typed", async () => {
    const html = await shopPage(
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

  it.each([null, "read"])(
    "keeps the Connect refusal in its panel with prior grant %s",
    async (permissions) => {
      const prior =
        permissions === null
          ? {}
          : {
              state: {
                kind: "connected" as const,
                shop: { shopUrl: SHOP, permissions, connectedAt: new Date("2026-10-12T09:00:00Z") },
              },
              through: "woocommerce" as const,
            };
      const html = await shopPage(prior, {
        problem: "Your shop did not show its approval screen.",
      });

      expect(problemsIn(blockOf(html, "/woocommerce/connect"))).toStrictEqual([
        "Your shop did not show its approval screen.",
      ]);
    },
  );

  it("keeps a publication refusal visible with the job, apart from the way out", async () => {
    const html = await shopPage(
      { state: CONNECTED, through: "woocommerce" },
      { importing: "Your shop answered 403: Forbidden" },
    );

    expect(problemsIn(html)).toStrictEqual(["Your shop answered 403: Forbidden"]);
    expect(problemsIn(blockOf(html, "/woocommerce/disconnect"))).toStrictEqual([]);
  });

  it("says a refused way back beside the way back, whether or not a shop is connected", async () => {
    const leaving = "An order still waits on the shop: ord_1.";
    for (const state of [CONNECTED, { kind: "none" } as const]) {
      const html = await shopPage({ state, through: "woocommerce" }, { leaving });

      expect(problemsIn(blockOf(html, "/woocommerce/disconnect")), state.kind).toStrictEqual([
        leaving,
      ]);
    }
  });

  it("says a refused switch beside the switch", async () => {
    const switching = "An order still waits on your code: ord_2.";
    const html = await shopPage({ state: CONNECTED, through: "api" }, { switching });

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

  it.each([5, 7])(
    "shows at most five blocking orders and discloses omitted rows out of %s",
    async (count) => {
      const orders = waiting(count);
      const block = blockOf(
        await shopPage(
          { state: CONNECTED, through: "api" },
          { switching: held("woocommerce", orders) },
        ),
        "/woocommerce/switch",
      );
      expect([...block.matchAll(/aria-label="Copy the whole order ID [^"]+"/g)]).toHaveLength(5);
      for (const id of orders.slice(0, 5)) expect(readable(block)).toContain(id);
      for (const id of orders.slice(5)) expect(readable(block)).not.toContain(id);
      if (count === 7) expect(readable(block)).toMatch(/\b2 more\b/);
      else expect(readable(block)).not.toMatch(/\bmore\b/);
      expect(block).toContain('href="/orders?show=open"');
    },
  );

  it("tells purchases about to lapse apart from goods owed: try again in a minute, naming none", async () => {
    const block = blockOf(
      await shopPage({}, { problem: held("woocommerce", waiting(3), { quick: true }) }),
      "/woocommerce/connect",
    );

    expect(readable(block)).toMatch(/try again/i);
    expect(readable(block)).toMatch(/within a minute/);
    expect(block).not.toMatch(/aria-label="Copy the whole order ID/);
    // A merchant whose buyers keep coming has no other way out.
    expect(block).toMatch(/<a href="\/products">[^<]*pause[^<]*<\/a>/i);
  });

  it("counts and names only the orders still open, which See open orders shows", async () => {
    // A purchase not yet priced is not on the open list, and one that ended
    // since the refusal is gone from it.
    const still = "ord_still0f3c9a1b2d4e6f8a7b9c";
    const block = blockOf(
      await shopPage(
        {},
        {
          problem: {
            held: heldBy(
              "woocommerce",
              ["ord_quote0f3c9a1b2d4e6f8a7b9c", still, "ord_ended0f3c9a1b2d4e6f8a7b9c"],
              [
                { id: still, status: "in_progress", payment_status: "paid" },
                {
                  id: "ord_other0f3c9a1b2d4e6f8a7b9c",
                  status: "in_progress",
                  payment_status: "paid",
                },
              ],
            ),
          },
        },
      ),
      "/woocommerce/connect",
    );

    expect(readable(block)).toMatch(/\b1 order from your code is still open/);
    expect([...block.matchAll(/aria-label="Copy the whole order ID [^"]+"/g)]).toHaveLength(1);
    expect(readable(block)).toContain(still);
    expect(readable(block)).not.toMatch(/delivers/);
  });

  it("asks to try again in a moment, claiming no order in progress, where no order it named is listed open", async () => {
    const html = await shopPage(
      {},
      { problem: { held: heldBy("woocommerce", ["ord_quote0f3c9a1b2d4e6f8a7b9c"], []) } },
    );
    const block = blockOf(html, "/woocommerce/connect");

    expect(block).toMatch(/<p class="problem">[^<]+<\/p>/);
    expect(formTo(html, "post", "/woocommerce/connect")?.presses).toHaveLength(1);
    expect(block).not.toContain("ord_quote0f3c9a1b2d4e6f8a7b9c");
    expect(block).not.toMatch(/aria-label="Copy the whole order ID/);
    expect(readable(block)).not.toMatch(/\b\d+ orders?\b/);
    expect(readable(block)).not.toMatch(/in progress|within a minute/);
  });

  it("says how a parcel ends where one holds the way out", async () => {
    const parcel = readable(
      blockOf(
        await shopPage(
          { state: CONNECTED, through: "woocommerce" },
          { leaving: held("api", waiting(2), { parcels: true }) },
        ),
        "/woocommerce/disconnect",
      ),
    );
    const none = readable(
      blockOf(
        await shopPage(
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

  it("draws what it was given as text, never as markup", async () => {
    const html = await shopPage(
      { state: CONNECTED, through: "woocommerce" },
      { importing: "Your shop answered <script>alert(1)</script>" },
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(readable(html)).toContain("Your shop answered <script>alert(1)</script>");
  });
});

describe("what the shop screen holds before it is pressed", () => {
  const importButton = (html: string): string =>
    /<button[^>]*>Publish 1 product<\/button>/.exec(formOf(html, "/woocommerce/import"))?.[0] ?? "";

  it("holds Import, naming the setting and where to set it, while every product would be refused", async () => {
    const html = await shopPage({
      state: CONNECTED,
      through: "woocommerce",
      unset: ["no_payout_wallet"],
    });
    expect(importButton(html)).toMatch(/\bdisabled\b/);
    expect(readable(html)).toContain("payout wallet");
    expect(html).toContain('href="/settings"');
  });

  it("holds Import until a shop priced in another currency has its rate", async () => {
    for (const reference of [
      { ok: false, listed: null },
      await coinbaseAsRecorded("IDR"),
    ] as const) {
      const html = await shopPage({
        state: CONNECTED,
        through: "woocommerce",
        rate: {
          currency: { code: "IDR", decimals: 0 },
          current: null,
          reference,
        },
      });

      expect(formOf(html, "/woocommerce/import")).toBe("");
      expect(readable(html)).toContain("We check your products once the rate is saved.");
      expect(formOf(html, "/woocommerce/rate")).toContain('name="rate"');
      expect(readable(html)).not.toContain("Check stopped");
      expect(readable(html)).not.toContain("The total is unknown.");
      const page = new DOMParser().parseFromString(html, "text/html");
      const field = page.querySelector('form[action="/woocommerce/rate"] input[name="rate"]');
      const hint = page.getElementById(field?.getAttribute("aria-describedby") ?? "");
      expect(hint?.textContent).toContain("Coinbase");
      if (reference.ok)
        expect(hint?.textContent?.replaceAll("\u00a0", " ")).toBe(
          "Coinbase today: 18,035 IDR per US dollar",
        );
      expect(field?.getAttribute("value")).toBe("");
    }
  });

  it("says a shop in a currency Coinbase gives no rate for cannot sell, and asks for no rate", async () => {
    const html = await shopPage({
      state: CONNECTED,
      through: "woocommerce",
      rate: {
        currency: { code: "IRT", decimals: 0 },
        current: null,
        reference: await coinbaseAsRecorded("IRT"),
      },
    });
    expect(formOf(html, "/woocommerce/import")).toBe("");
    expect(readable(html)).toContain(
      "Coinbase gives no rate for IRT, so no rate can be saved for this shop.",
    );
    expect(formOf(html, "/woocommerce/rate")).toBe("");
  });

  it("offers Import where nothing stands in its way, and where what stands could not be read", async () => {
    for (const unset of [[], null] as const) {
      const html = await shopPage({ state: CONNECTED, through: "woocommerce", unset });

      const page = new DOMParser().parseFromString(html, "text/html");
      const button = page.querySelector<HTMLButtonElement>(
        'form[action="/woocommerce/import"] button',
      );
      expect(button).not.toBeNull();
      expect(button?.disabled, String(unset)).toBe(false);
    }
  });

  it("offers the switch and no Import while the merchant sells through their own code", async () => {
    const html = await shopPage({ state: CONNECTED, through: "api" });

    expect(formTo(html, "post", "/woocommerce/switch")).toBeDefined();
    expect(formTo(html, "post", "/woocommerce/import")).toBeUndefined();
  });

  it("asks before it disconnects a connected shop: every press stands inside a closed disclosure", async () => {
    for (const through of ["woocommerce", "api"] as const) {
      const page = new DOMParser().parseFromString(
        await shopPage({ state: CONNECTED, through }),
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

  it("says a grant short of Read/Write as a warning rather than as connected, and never calls a write grant read-only", async () => {
    for (const permissions of ["read", "write"]) {
      const html = await shopPage({
        state: {
          kind: "connected",
          shop: { shopUrl: SHOP, permissions, connectedAt: new Date() },
        },
        through: "woocommerce",
      });
      const text = readable(html);
      expect(formTo(html, "post", "/woocommerce/connect")).toBeDefined();
      for (const action of ["import", "rate", "switch"])
        expect(formTo(html, "post", `/woocommerce/${action}`)).toBeUndefined();

      expect(text, permissions).toContain("can't create orders");
      if (permissions === "write") expect(text).not.toMatch(/read-only/i);
      else expect(text).toMatch(/read-only access/i);
      expect(text, permissions).not.toContain("Connected");
    }
  });
});

describe("what the shop screen says a switch does to the code's products", () => {
  const connectPanel = async (codeProducts: number | null) =>
    readable(blockOf(await shopPage({ through: "api", codeProducts }), "/woocommerce/connect"));

  it.each([null, "read"])(
    "discloses the switch's product consequences with prior grant %s",
    async (permissions) => {
      const panel = async (codeProducts: number | null) =>
        permissions === null
          ? await connectPanel(codeProducts)
          : readable(
              blockOf(
                await shopPage({
                  state: {
                    kind: "connected",
                    shop: {
                      shopUrl: SHOP,
                      permissions,
                      connectedAt: new Date("2026-10-12T09:00:00Z"),
                    },
                  },
                  through: "api",
                  codeProducts,
                }),
                "/woocommerce/connect",
              ),
            );
      expect(await panel(12)).toContain("the 12 products your code published go off sale");
      expect(await panel(1)).toContain("the product your code published goes off sale");
      expect(await panel(null)).toContain("the products your code published go off sale");
      expect(await panel(0)).not.toMatch(/off sale/);
    },
  );

  it("says the code's products come back paused, where there are some, on the way back", async () => {
    const back = async (codeProducts: number) =>
      readable(
        blockOf(
          await shopPage({ state: { kind: "none" }, through: "woocommerce", codeProducts }),
          "/woocommerce/disconnect",
        ),
      );

    expect(await back(12)).toMatch(/12 products your code published come back paused/);
    expect(await back(0)).not.toMatch(/come back/);
  });
});

describe("what the shop screen offers while no keys are here", () => {
  it("offers to check again while the fifteen minutes run, with the address in the box", async () => {
    const html = await shopPage({
      state: { kind: "waiting", shopUrl: SHOP, startedMinutesAgo: 4 },
      through: "woocommerce",
    });

    expect(readable(html)).toContain("Check again");
    expect(formTo(html, "post", "/woocommerce/connect")).toBeDefined();
    expect(formOf(html, "/woocommerce/connect")).toContain(`value="${SHOP}"`);
  });

  it("offers only Connect again once they ran out, and still keeps the address", async () => {
    const html = await shopPage({ state: { kind: "unanswered", shopUrl: SHOP }, through: "api" });

    expect(readable(html)).not.toContain("Check again");
    expect(readable(html)).toContain("We didn't hear back");
    expect(formOf(html, "/woocommerce/connect")).toContain(`value="${SHOP}"`);
  });
});
