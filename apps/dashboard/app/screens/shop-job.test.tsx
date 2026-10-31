import { prerender } from "react-dom/static";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { presentShopJob } from "../../src/shop-job-presentation.js";
import type { ShopJobState } from "../../src/shop-job-view.js";
import { formTo, readable } from "../../src/testing/html.js";
import { ShopJobPanel } from "./shop-job.js";
import { ShopJobResult } from "./shop-job-result.js";
import { ShopJobSummary } from "./shop-job-summary.js";

const result: ShopJobState = {
  id: "observed-job",
  revision: 2,
  kind: "check",
  status: "completed",
  shopHost: "woo.nuanu.ai",
  read: 100,
  total: 100,
  ready: 72,
  published: 0,
  excluded: 0,
  publicationUnknown: null,
  currency: "USD",
  when: { text: "30 Oct 2026, 12:09 EDT" },
  why: null,
  stopCode: null,
  current: true,
  groups: [],
};
const rendered = async (state: ShopJobState, summary = false, noProducts = false) => {
  const view = presentShopJob(state);
  const Stub = createRoutesStub([
    {
      id: "routes/gate",
      path: "/",
      children: [
        {
          path: "products",
          Component: () =>
            summary ? (
              <ShopJobSummary
                initial={view}
                noProducts={noProducts}
                endpoint="/shop-job"
                summaryTo="/woocommerce"
                checkAction="/products?woo=check"
              />
            ) : view.status === "running" || view.status === "queued" ? (
              <ShopJobPanel initial={view} endpoint="/shop-job" />
            ) : (
              <ShopJobResult view={view} unread={false} noProducts={noProducts} />
            ),
        },
      ],
    },
  ]);
  const { prelude } = await prerender(
    <Stub
      initialEntries={["/products"]}
      hydrationData={{ loaderData: { "routes/gate": { who: "owner@example.com" } } }}
    />,
  );
  return new Response(prelude).text();
};

const shown = async (view: ShopJobState, summary = false, noProducts = false) =>
  readable(await rendered(view, summary, noProducts)).replace(/\s+([.,])/g, "$1");

describe("a merchant reading a shop result", async () => {
  it("keeps known rate-required work visible to an operator without a rate form", async () => {
    const { prelude } = await prerender(
      <ShopJobResult
        view={presentShopJob(
          {
            ...result,
            status: "stopped",
            stopCode: "rate_required",
            read: 0,
            total: null,
            ready: 0,
          },
          "operator",
        )}
        unread={false}
      />,
    );
    const text = readable(await new Response(prelude).text());
    expect(text).toContain("Check stopped");
    expect(text).toContain("The total is unknown.");
    expect(text).not.toContain("Save rate");
  });

  it.each([
    ["rate_required", "Set your exchange rate"],
    ["reconnect", "Reconnect your shop"],
  ] as const)("takes catalogue recovery to the shop detail for %s", async (stopCode, next) => {
    const html = await rendered({ ...result, status: "stopped", stopCode, ready: 0 }, true);
    expect(readable(html)).toContain(next);
    expect(html).toContain('href="/woocommerce"');
    expect(readable(html)).not.toContain("Sync with your shop");
    expect(readable(html)).not.toContain("Check again");
  });

  it("keeps an interrupted publication's catalogue action without its full product groups", async () => {
    const text = await shown(
      {
        ...result,
        kind: "publish",
        status: "stopped",
        stopCode: "unknown",
        groups: [
          {
            group: "ready",
            title: "Ready",
            count: 1,
            reasons: [
              {
                why: "",
                code: "ready",
                count: 1,
                rows: [{ id: "11", title: "Guide", why: "" }],
                more: null,
              },
            ],
          },
        ],
      },
      true,
    );
    expect(text).toContain("Sync with your shop");
    expect(text).not.toContain("Check again");
    expect(text).not.toContain("Guide");
  });

  it.each(
    [false, true].flatMap((compact) =>
      ([null, "rate_required", "reconnect"] as const).map(
        (stopCode) => [compact, stopCode] as const,
      ),
    ),
  )(
    "offers only a new check for an earlier connection or rate (compact: %s, recovery: %s)",
    async (compact, stopCode) => {
      const props = {
        view: presentShopJob({
          ...result,
          status: stopCode === null ? "completed" : "stopped",
          current: false,
          stopCode,
        }),
        unread: false,
        checkAction: "/woocommerce/check",
        publish: () => <button type="button">Publish products</button>,
        rate: () => <button type="button">Save rate</button>,
        reconnect: <button type="button">Connect again</button>,
      };
      const Stub = createRoutesStub([
        {
          id: "routes/gate",
          path: "/",
          children: [
            {
              path: "woocommerce",
              Component: () =>
                compact ? (
                  <ShopJobSummary
                    initial={props.view}
                    endpoint="/shop-job"
                    summaryTo="/woocommerce"
                    checkAction={props.checkAction}
                  />
                ) : (
                  <ShopJobResult {...props} />
                ),
            },
          ],
        },
      ]);
      const { prelude } = await prerender(
        <Stub
          initialEntries={["/woocommerce"]}
          hydrationData={{ loaderData: { "routes/gate": { who: "owner@example.com" } } }}
        />,
      );
      const html = await new Response(prelude).text();
      expect(
        formTo(html, "post", props.checkAction)?.presses.some(
          ({ label }) => label === "Check again",
        ),
      ).toBe(true);
      expect(readable(html)).not.toContain("Publish products");
      expect(readable(html)).not.toContain("Save rate");
      expect(readable(html)).not.toContain("Connect again");
    },
  );

  it.each([
    [1, "1 more product can go on sale once you fix it in your shop."],
    [2, "2 more products can go on sale once you fix them in your shop."],
  ] as const)("agrees the fix instruction with %i product(s)", async (count, instruction) => {
    expect(
      await shown(
        { ...result, groups: [{ group: "fix", title: "To fix in your shop", count, reasons: [] }] },
        true,
      ),
    ).toBe(instruction);
  });

  it("keeps the ordinary Products list quiet when nothing is left to fix", async () => {
    expect(await shown(result, true)).toBe("");
  });

  it("keeps active progress compact and groups finished counts and hidden-row counts", async () => {
    const view: ShopJobState = {
      ...result,
      status: "running",
      read: 1240,
      total: 1990,
      ready: 1240,
      groups: [
        {
          group: "ready",
          title: "Ready",
          count: 1240,
          reasons: [
            {
              why: "",
              code: "ready",
              count: 1240,
              rows: [],
              more: { href: "?show_ready_ready=60", left: 1230 },
            },
          ],
        },
      ],
    };
    const text = await shown(view);
    expect(text).toContain("1,240 of 1,990 products read.");
    expect(text).not.toContain("Ready 1,240");
    expect(text).not.toContain("Show 50 more");
    const finished = await shown({ ...view, status: "completed" });
    expect(finished).toContain("Ready 1,240");
    expect(finished).toContain("Show 50 more (1,230 left)");
  });

  it("reports an interrupted check against the known total and qualifies the ready subset as read", async () => {
    const text = await shown({
      ...result,
      status: "stopped",
      read: 1,
      total: 2,
      ready: 1,
      stopCode: "unread",
    });
    expect(text).toContain("Stopped after 1 of 2 products.");
    expect(text).toContain("1 of 1 product read can sell through Agentify.");
    expect(text).toContain("We don't know about the rest yet.");
  });

  it("distinguishes unanswered inspections from products left unread", async () => {
    const text = await shown({
      ...result,
      status: "stopped",
      stopCode: "unread",
      read: 7,
      total: 7,
      ready: 6,
      groups: [{ group: "unanswered", title: "No answer from your shop", count: 1, reasons: [] }],
    });
    expect(text).toContain("7 of 7 products read.");
    expect(text).toContain("Some products could not be checked.");
    expect(text).not.toContain("We don't know about the rest yet.");
  });

  it("does not turn an unconfirmed publication into a confirmed zero", async () => {
    const text = await shown({
      ...result,
      kind: "publish",
      status: "stopped",
      stopCode: "unknown",
      read: 1,
      total: 2,
      published: 0,
    });
    expect(text).toContain("We couldn't confirm the last publication.");
    expect(text).toContain("0 products were confirmed on sale during this publication.");
    expect(text).toContain("1 of 2 products read.");
    expect(text).not.toContain("We published 0");
  });

  it("uses the stopped publication counts and singular agreement", async () => {
    const text = await shown({
      ...result,
      kind: "publish",
      status: "stopped",
      stopCode: "interrupted",
      read: 6,
      total: 6,
      published: 1,
    });
    expect(text).toContain(
      "We published 1 product and stopped after 6 of 6. We don't know about the rest yet.",
    );
  });

  it("says nothing is on sale only when Products knows its unfiltered list is empty", async () => {
    const unread: ShopJobState = {
      ...result,
      kind: "publish",
      status: "stopped",
      stopCode: "unread",
      read: 0,
      total: null,
      ready: 0,
    };
    const empty = await shown(unread, true, true);
    const priorProduct = await shown(unread, true, false);
    expect(empty).toContain("We couldn't read woo.nuanu.ai, so nothing is on sale yet.");
    expect(priorProduct).toContain("We couldn't read woo.nuanu.ai.");
    expect(priorProduct).toContain("No products were confirmed for sale in this sync.");
    expect(priorProduct).not.toContain("nothing is on sale yet");
  });

  it.each([
    { current: false },
    { kind: "check" as const },
    { status: "completed" as const, total: 0 },
    { stopCode: "unknown" as const },
    { read: 1 },
  ])("does not claim an empty sale outcome for a different job state: %j", async (changed) => {
    const text = await shown(
      {
        ...result,
        kind: "publish",
        status: "stopped",
        stopCode: "unread",
        read: 0,
        total: null,
        ready: 0,
        ...changed,
      },
      true,
      true,
    );
    expect(text).not.toContain("nothing is on sale yet");
  });
  it("prints a shared shop reason once and keeps shop text escaped", async () => {
    const why = "Download access expires. <script>alert(1)</script>";
    const html = await rendered({
      ...result,
      ready: 0,
      groups: [
        {
          group: "fix",
          title: "To fix in your shop",
          count: 3,
          reasons: [
            {
              why,
              code: "card",
              count: 3,
              more: null,
              rows: [
                { id: "11", title: "Guide", why: "" },
                { id: "12", title: "Coffee beans", why: "" },
                { id: "13", title: "Batik sarong", why: "" },
              ],
            },
          ],
        },
      ],
    });
    expect(readable(html).match(/Download access expires/g)).toHaveLength(1);
    expect(html.match(/<li\b/g)).toHaveLength(3);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("labels mixed shop issues as a group and keeps each repair beside its product", async () => {
    const first = "Ships as a parcel; choose a delivery option at checkout.";
    const second = "Download access requires a customer login.";
    const text = await shown({
      ...result,
      groups: [
        {
          group: "fix",
          title: "To fix in your shop",
          count: 2,
          reasons: [
            {
              code: "product_conditions",
              why: "Different shop issues",
              count: 2,
              rows: [
                { id: "41", title: "Guide", why: first },
                { id: "42", title: "Notebook", why: second },
              ],
              more: null,
            },
          ],
        },
      ],
    });
    expect(text).toContain(first);
    expect(text).toContain(second);
    expect(text).toContain("Different shop issues (2)");
  });

  it("shows a canonical variant reason once without repeating raw shop explanations", async () => {
    const text = await shown({
      ...result,
      groups: [
        {
          group: "unsupported",
          title: "Not supported yet",
          count: 2,
          reasons: [
            {
              code: "variants",
              why: "Has options such as size or colour",
              count: 2,
              rows: [
                { id: "31", title: "Hat", why: "" },
                { id: "32", title: "Shirt", why: "" },
              ],
              more: null,
            },
          ],
        },
      ],
    });
    expect(text).toContain("Has options such as size or colour (2)");
    expect(text).not.toContain("The product has size options");
    expect(text).not.toContain("The product has colour options");
  });

  it("never turns an unread shop into a known empty catalogue", async () => {
    const empty = await shown({ ...result, read: 0, total: 0, ready: 0 });
    const unread = await shown({
      ...result,
      status: "stopped",
      stopCode: "unread",
      read: 0,
      total: null,
      ready: 0,
    });
    expect(empty).toContain("Your shop has no products yet.");
    expect(unread).not.toContain("Your shop has no products yet.");
    expect(unread).toContain("The total is unknown.");
  });
});

it.each([
  {
    status: "completed" as const,
    stopCode: null,
    read: 100,
    total: 100,
    says: "No products were confirmed for sale in this publication.",
  },
  {
    status: "stopped" as const,
    stopCode: "unread" as const,
    read: 0,
    total: null,
    says: "We couldn't read woo.nuanu.ai. No products were confirmed for sale in this sync.",
  },
  {
    status: "stopped" as const,
    stopCode: "interrupted" as const,
    read: 40,
    total: 100,
    says: "We published 0 products and stopped after 40 of 100. We don't know about the rest yet.",
  },
])("states what a $status publication confirmed", async (state) => {
  const text = await shown({ ...result, ...state, kind: "publish", published: 0 });
  expect(text).toContain(state.says);
  expect(text).not.toContain("published no products");
  expect(text).not.toContain("0 products from this check are on sale");
});
