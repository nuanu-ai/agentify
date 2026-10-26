import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { formTo } from "../../src/testing/html.js";
import type { WooRecoveryView } from "../../src/woo-recovery-pages.js";
import { WooRecoveryScreen } from "./woocommerce-recovery.js";

const PATH = "/integrations/woocommerce/recover/ord_1";
const draw = (
  mode: WooRecoveryView["mode"],
  typedRefusal: string | null = null,
  more: Partial<WooRecoveryView> = {},
) => {
  const view: WooRecoveryView = {
    orderId: "ord_1",
    product: "woo_merchant_22",
    shopOrigin: "https://shop.example.com",
    amount: "0.01 USD",
    mode,
    wooOrderId: mode === "link" ? "" : "13",
    message: null,
    unknown: false,
    unavailable: mode === "unavailable" ? { shopOrder: "none", instead: "close" } : null,
    typedRefusal,
    ...more,
  };
  const Stub = createRoutesStub([
    {
      id: "routes/gate",
      path: "/",
      children: [
        {
          path: PATH,
          Component: () => <WooRecoveryScreen view={view} base="/dashboard" />,
        },
      ],
    },
  ]);
  return renderToString(
    <Stub
      initialEntries={[PATH]}
      hydrationData={{
        loaderData: { "routes/gate": { who: "owner@example.com" } },
      }}
    />,
  );
};

describe("the merchant's recovery controls", () => {
  it("asks for one exact shop ID only while the sale is unbound", () => {
    const form = formTo(draw("link"), "post", PATH);
    expect(form).toBeDefined();
    expect(form?.fields.has("woo_order_id")).toBe(true);
    const retry = formTo(draw("retry"), "post", PATH);
    expect(retry).toBeDefined();
    expect(retry?.fields.has("woo_order_id")).toBe(false);
  });

  it("offers one create press with no shop order ID box for a sale its shop never received", () => {
    const form = formTo(draw("create", null, { wooOrderId: "" }), "post", PATH);

    expect(form).toBeDefined();
    expect(form?.fields.has("woo_order_id")).toBe(false);
  });

  it("offers no create press while what the last press did is unknown", () => {
    const html = draw("create", null, { wooOrderId: "", message: "We don't know.", unknown: true });

    expect(formTo(html, "post", PATH)).toBeUndefined();
    expect(html).toContain(`href="/dashboard${PATH}"`);
  });

  it("leads a sale waiting for its shop to be connected again to the WooCommerce page", () => {
    const html = draw("unavailable", null, {
      unavailable: { shopOrder: "none", instead: "reconnect" },
    });

    expect(formTo(html, "post", PATH)).toBeUndefined();
    expect(html).toContain('href="/dashboard/woocommerce"');
  });

  it("removes the action after confirmed delivery or when recovery is unavailable", () => {
    expect(formTo(draw("delivered"), "post", PATH)).toBeUndefined();
    expect(formTo(draw("unavailable"), "post", PATH)).toBeUndefined();
  });

  it("leads an unavailable recovery to closing fulfillment on the order", () => {
    expect(draw("unavailable")).toContain('href="/dashboard/orders?q=ord_1"');
  });

  it("says a shop order nobody knows of differently from one the shop never got", () => {
    for (const instead of ["close", "nothing"] as const) {
      const unknown = draw("unavailable", null, { unavailable: { shopOrder: "unknown", instead } });
      const none = draw("unavailable", null, { unavailable: { shopOrder: "none", instead } });

      expect(unknown, instead).not.toBe(none);
    }
  });

  it("offers a reload rather than a second press while what the last press did is unknown", () => {
    for (const mode of ["link", "retry"] as const) {
      const html = draw(mode, null, { message: "We don't know if this worked.", unknown: true });

      expect(formTo(html, "post", PATH), mode).toBeUndefined();
      expect(html, mode).toContain(`href="/dashboard${PATH}"`);
    }
  });

  it("says why a typed shop order was refused under its box, and marks the box", () => {
    const html = draw(
      "link",
      "That order does not match this sale: it was not paid with Agentify.",
    );
    const box = /<input[^>]*name="woo_order_id"[^>]*>/.exec(html)?.[0] ?? "";
    const line = /aria-describedby="([^"]+)"/.exec(box)?.[1];

    expect(box).toContain('aria-invalid="true"');
    expect(html).toMatch(
      new RegExp(
        `id="${line}"[^>]*>That order does not match this sale: it was not paid with Agentify.<`,
      ),
    );
  });
});
