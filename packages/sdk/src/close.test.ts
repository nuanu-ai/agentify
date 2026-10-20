import { afterEach, expect, it } from "vitest";
import { createClient } from "./index.js";
import { type FakeGateway, startFakeGateway } from "./testing/fake-gateway.js";

let gateway: FakeGateway | undefined;
afterEach(async () => {
  await gateway?.close();
});

it("closes through a bound order with the merchant key and preserves the explanation", async () => {
  gateway = await startFakeGateway({
    apiKey: "merchant-close-key",
    routes: {
      close_order: () => ({ body: { ok: true } }),
    },
  });
  const client = createClient({ apiKey: "merchant-close-key", baseUrl: gateway.url });
  const order = client.orders.forId("ord/private");
  expect(await order.close()).toStrictEqual({ ok: true });
  expect(await order.close({ message: "  We will contact you outside Agentify.  " })).toStrictEqual(
    { ok: true },
  );
  expect(
    gateway.callsTo("close_order").map(({ params, body, apiKey }) => ({ params, body, apiKey })),
  ).toStrictEqual([
    { params: { order_id: "ord/private" }, body: {}, apiKey: "merchant-close-key" },
    {
      params: { order_id: "ord/private" },
      body: { message: "  We will contact you outside Agentify.  " },
      apiKey: "merchant-close-key",
    },
  ]);
});

it("returns a closure refusal and makes an unreadable answer safe to retry", async () => {
  const error = {
    code: "order_already_closed",
    message: "A shipment is already recorded.",
    retryable: false,
  };
  gateway = await startFakeGateway({
    apiKey: "merchant-close-key",
    routes: {
      close_order: (_call, index) =>
        index === 0
          ? { status: 409, body: { ok: false, error } }
          : { text: "connection lost after closure" },
    },
  });
  const client = createClient({ apiKey: "merchant-close-key", baseUrl: gateway.url });
  expect(await client.orders.forId("ord_closed").close()).toStrictEqual({ ok: false, error });
  const unknown = await client.orders.forId("ord_closed").close();
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.error.retryable).toBe(true);
});
