import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { formTo } from "../../src/testing/html.js";
import type { WooRecoveryView } from "../../src/woo-recovery-pages.js";
import { WooRecoveryScreen } from "./woocommerce-recovery.js";

const PATH = "/integrations/woocommerce/recover/ord_1";
const draw = (mode: WooRecoveryView["mode"], typedRefusal: string | null = null) => {
  const view: WooRecoveryView = {
    orderId: "ord_1",
    product: "woo_merchant_22",
    shopOrigin: "https://shop.example.com",
    amount: "0.01 USD",
    test: true,
    mode,
    wooOrderId: mode === "link" ? "" : "13",
    message: null,
    typedRefusal,
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

  it("removes the action after confirmed delivery or when recovery is unavailable", () => {
    expect(formTo(draw("delivered"), "post", PATH)).toBeUndefined();
    expect(formTo(draw("unavailable"), "post", PATH)).toBeUndefined();
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
