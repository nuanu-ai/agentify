/**
 * The controlled Woo fault's edge between a stand-in shop on loopback and a
 * raw `node:http` caller, served over plain http here: TLS is the stack's
 * part, and what the organiser is promised is where each fault lands. A
 * failure lands before the shop or, for a cut, after the shop answered; a hold
 * keeps an order from the shop until that order is released; a shift changes
 * only the chosen order; the dashboard's traffic is never touched.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { type Edge, serveWooFault, wooFaultEdge } from "./woo-fault-command.js";

const SHOP = "shop.woo-fault.test";
const DASHBOARD = "agentify.woo-fault.test";
const ORDERS = "/wp-json/wc/v3/orders";

interface Received {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

interface Server {
  readonly url: string;
  readonly received: Received[];
}

interface Reply {
  readonly status: number | null;
  readonly body: string;
  readonly error: string | null;
}

const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()));
});

const serve = async (
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> => {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closing.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/** Answers an order with the next shop order number, anything else with an empty list. */
const standInShop = async (): Promise<Server> => {
  const received: Received[] = [];
  const url = await serve(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    received.push({
      method: request.method ?? "",
      url: request.url ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
    });
    const creating = request.method === "POST" && request.url?.startsWith(ORDERS) === true;
    response.writeHead(creating ? 201 : 200, { "content-type": "application/json" });
    response.end(creating ? JSON.stringify({ id: 100 + received.length }) : "[]");
  });
  return { url, received };
};

const edgeFor = async (
  shop: Server,
  stack: Server,
): Promise<{ readonly port: number; readonly edge: Edge; readonly log: string[] }> => {
  const log: string[] = [];
  const edge = wooFaultEdge(
    {
      shopHost: SHOP,
      shop: new URL(shop.url),
      dashboardHost: DASHBOARD,
      dashboard: new URL(stack.url),
      gateway: new URL(stack.url),
    },
    (line) => log.push(line),
  );
  const url = await serve(edge.handle);
  return { port: Number(new URL(url).port), edge, log };
};

const call = (
  port: number,
  host: string,
  method: string,
  path: string,
  body = "",
  { leaveAfterMs }: { readonly leaveAfterMs?: number } = {},
): Promise<Reply> =>
  new Promise((resolve) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: { host, "content-type": "application/json" },
      agent: false,
    });
    request.on("error", (error: NodeJS.ErrnoException) =>
      resolve({ status: null, body: "", error: error.code ?? error.message }),
    );
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? null,
          body: Buffer.concat(chunks).toString("utf8"),
          error: null,
        }),
      );
    });
    request.end(body);
    if (leaveAfterMs !== undefined) {
      setTimeout(() => request.destroy(new Error("the caller gave up")), leaveAfterMs);
    }
  });

const orderBody = (order: string) =>
  JSON.stringify({
    transaction_id: order,
    meta_data: [{ key: "agentify_order_id", value: order }],
    line_items: [{ product_id: 12, quantity: 1, subtotal: "4.00", total: "4.00" }],
  });

const armed = (edge: Edge, argv: readonly string[]): string => {
  const said = edge.control(argv);
  expect(said.ok, said.said).toBe(true);
  return said.said;
};

const settled = async (until: () => boolean): Promise<void> => {
  for (let waited = 0; waited < 5_000 && !until(); waited += 5) await pause(5);
};

describe("failing a chosen shop request", () => {
  it("answers matching product reads without the shop seeing them, as many as armed, first rule first, and the next one reaches the shop", async () => {
    const shop = await standInShop();
    const { port, edge } = await edgeFor(shop, await standInShop());
    const products = "/wp-json/wc/v3/products/*";
    armed(edge, ["fail", "--method", "GET", "--path", products, "--fault", "503", "--count", "2"]);
    armed(edge, ["fail", "--method", "GET", "--path", products, "--fault", "429"]);

    const statuses: (number | null)[] = [];
    for (const path of [
      "/wp-json/wc/v3/products/12",
      "/wp-json/wc/v3/products/12/variations",
      "/wp-json/wc/v3/settings/general",
      "/wp-json/wc/v3/products/12",
      "/wp-json/wc/v3/products/12",
      "/wp-json/wc/v3/products/12",
    ]) {
      statuses.push((await call(port, SHOP, "GET", path)).status);
    }

    expect(statuses).toEqual([503, 200, 200, 503, 429, 200]);
    expect(shop.received.map((one) => one.url)).toEqual([
      "/wp-json/wc/v3/products/12/variations",
      "/wp-json/wc/v3/settings/general",
      "/wp-json/wc/v3/products/12",
    ]);
  });

  it.each([
    ["malformed", 200, null],
    ["drop", null, "ECONNRESET"],
  ])("with %s, keeps the request from the shop", async (fault, status, error) => {
    const shop = await standInShop();
    const { port, edge } = await edgeFor(shop, await standInShop());
    armed(edge, [
      "fail",
      "--method",
      "GET",
      "--path",
      "/wp-json/wc/store/v1/products",
      "--fault",
      fault,
      "--count",
      "all",
    ]);

    const first = await call(port, SHOP, "GET", "/wp-json/wc/store/v1/products?per_page=1");
    const second = await call(port, SHOP, "GET", "/wp-json/wc/store/v1/products?per_page=10");

    for (const reply of [first, second]) {
      expect(reply.status).toBe(status);
      if (error !== null) expect(reply.error).toBe(error);
    }
    if (fault === "malformed") expect(() => JSON.parse(first.body)).toThrow();
    expect(shop.received).toEqual([]);
  });

  it("with cut, lets the shop create the order and leaves the caller with no answer, once", async () => {
    const shop = await standInShop();
    const { port, edge } = await edgeFor(shop, await standInShop());
    armed(edge, ["fail", "--method", "POST", "--path", ORDERS, "--fault", "cut"]);

    const cut = await call(port, SHOP, "POST", ORDERS, orderBody("ord_cut"));
    const again = await call(port, SHOP, "POST", ORDERS, orderBody("ord_cut"));

    expect(cut.status).toBeNull();
    expect(cut.error).toBe("ECONNRESET");
    expect(again.status).toBe(201);
    expect(shop.received).toHaveLength(2);
  });

  it("leaves the dashboard's traffic alone even where a failure's pattern covers its path, and answers no other name", async () => {
    const shop = await standInShop();
    const dashboard = await standInShop();
    const gateway = await standInShop();
    const log: string[] = [];
    const edge = wooFaultEdge(
      {
        shopHost: SHOP,
        shop: new URL(shop.url),
        dashboardHost: DASHBOARD,
        dashboard: new URL(dashboard.url),
        gateway: new URL(gateway.url),
      },
      (line) => log.push(line),
    );
    const port = Number(new URL(await serve(edge.handle)).port);
    armed(edge, ["fail", "--method", "POST", "--path", "/**", "--fault", "503", "--count", "all"]);

    const callback = await call(port, DASHBOARD, "POST", "/dashboard/woocommerce/callback", "{}");
    const purchase = await call(port, DASHBOARD, "POST", "/x402/item_1/purchase", "{}");
    const elsewhere = await call(port, "woo.nuanu.ai", "POST", "/wp-json/wc/v3/orders", "{}");

    expect([callback.status, purchase.status, elsewhere.status]).toEqual([200, 200, 421]);
    expect(dashboard.received.map((one) => one.url)).toEqual(["/dashboard/woocommerce/callback"]);
    expect(gateway.received.map((one) => one.url)).toEqual(["/x402/item_1/purchase"]);
    expect(shop.received).toEqual([]);
    expect(log).toEqual([]);
  });
});

describe("holding an order before the shop", () => {
  it("keeps the next order's creating request from the shop until it is released by that order's identifier", async () => {
    const shop = await standInShop();
    const { port, edge } = await edgeFor(shop, await standInShop());
    armed(edge, ["hold", "--next"]);

    const held = call(port, SHOP, "POST", ORDERS, orderBody("ord_held"));
    await settled(() => edge.control(["status"]).said.includes("ord_held"));
    const other = await call(port, SHOP, "POST", ORDERS, orderBody("ord_other"));

    expect(shop.received.map((one) => JSON.parse(one.body).transaction_id)).toEqual(["ord_other"]);
    expect(other.status).toBe(201);
    expect(edge.control(["release", "--order", "ord_other"]).ok).toBe(false);

    armed(edge, ["release", "--order", "ord_held"]);
    expect((await held).status).toBe(201);
    expect(shop.received.map((one) => JSON.parse(one.body).transaction_id)).toEqual([
      "ord_other",
      "ord_held",
    ]);
  });

  it("never sends a held request whose caller gave up before the release", async () => {
    const shop = await standInShop();
    const { port, edge } = await edgeFor(shop, await standInShop());
    armed(edge, ["hold", "--order", "ord_gone"]);

    const gone = await call(port, SHOP, "POST", ORDERS, orderBody("ord_gone"), {
      leaveAfterMs: 50,
    });
    expect(gone.status).toBeNull();
    await settled(() => edge.control(["status"]).said.includes("gave up"));
    armed(edge, ["release", "--order", "ord_gone"]);
    await pause(100);

    expect(shop.received).toEqual([]);
  });

  it("lets clear disarm a hold whose caller gave up, without sending it, and keeps one still waiting", async () => {
    const shop = await standInShop();
    const { port, edge } = await edgeFor(shop, await standInShop());
    armed(edge, ["hold", "--order", "ord_gone"]);
    armed(edge, ["hold", "--order", "ord_waiting"]);

    await call(port, SHOP, "POST", ORDERS, orderBody("ord_gone"), { leaveAfterMs: 50 });
    const waiting = call(port, SHOP, "POST", ORDERS, orderBody("ord_waiting"));
    await settled(() => {
      const said = edge.control(["status"]).said;
      return said.includes("gave up") && said.includes("ord_waiting: #");
    });
    armed(edge, ["clear"]);
    const again = await call(port, SHOP, "POST", ORDERS, orderBody("ord_gone"));
    await pause(50);

    expect(again.status).toBe(201);
    expect(shop.received.map((one) => JSON.parse(one.body).transaction_id)).toEqual(["ord_gone"]);
    armed(edge, ["release", "--order", "ord_waiting"]);
    expect((await waiting).status).toBe(201);
  });
});

describe("a copy that does not accept the connection", () => {
  it("is answered 502 by the edge, and neither the shift nor the cut armed for that order is spent", async () => {
    const received: Received[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 200 + received.length }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const shopPort = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { port, edge } = await edgeFor(
      { url: `http://127.0.0.1:${shopPort}`, received },
      await standInShop(),
    );
    armed(edge, ["shift", "--next", "--by", "1"]);
    armed(edge, ["fail", "--method", "POST", "--path", ORDERS, "--fault", "cut"]);

    const unreachable = await call(port, SHOP, "POST", ORDERS, orderBody("ord_waiting"));
    await new Promise<void>((resolve) => server.listen(shopPort, "127.0.0.1", resolve));
    closing.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const reached = await call(port, SHOP, "POST", ORDERS, orderBody("ord_waiting"));

    expect(unreachable.status).toBe(502);
    expect(reached.status).toBeNull();
    expect(received.map((one) => JSON.parse(one.body).fee_lines)).toEqual([
      [{ name: "Controlled Woo fault: total shifted by 1", total: "1", tax_status: "none" }],
    ]);
  });
});

describe("shifting an order's total", () => {
  it("adds one untaxed fee line of the amount to the chosen order's request and leaves another order's as it came", async () => {
    const shop = await standInShop();
    const { port, edge } = await edgeFor(shop, await standInShop());
    armed(edge, ["shift", "--order", "ord_shifted", "--by", "-1"]);

    await call(port, SHOP, "POST", ORDERS, orderBody("ord_plain"));
    await call(port, SHOP, "POST", ORDERS, orderBody("ord_shifted"));
    await call(port, SHOP, "POST", ORDERS, orderBody("ord_shifted"));

    const [plain, shifted, repeated] = shop.received.map((one) => JSON.parse(one.body));
    expect(plain).toEqual(JSON.parse(orderBody("ord_plain")));
    expect(shifted).toEqual({
      ...JSON.parse(orderBody("ord_shifted")),
      fee_lines: [
        { name: "Controlled Woo fault: total shifted by -1", total: "-1", tax_status: "none" },
      ],
    });
    expect(repeated.fee_lines).toBeUndefined();
  });

  it("with --next, shifts the next order the shop is sent, not one the edge failed before the shop", async () => {
    const shop = await standInShop();
    const { port, edge } = await edgeFor(shop, await standInShop());
    armed(edge, ["fail", "--method", "POST", "--path", ORDERS, "--fault", "503"]);
    armed(edge, ["shift", "--next", "--by", "2"]);

    expect((await call(port, SHOP, "POST", ORDERS, orderBody("ord_refused"))).status).toBe(503);
    await call(port, SHOP, "POST", ORDERS, orderBody("ord_sent"));

    expect(shop.received.map((one) => JSON.parse(one.body))).toEqual([
      {
        ...JSON.parse(orderBody("ord_sent")),
        fee_lines: [
          { name: "Controlled Woo fault: total shifted by 2", total: "2", tax_status: "none" },
        ],
      },
    ]);
  });

  it("refuses an amount that is not one, and arms nothing", async () => {
    const shop = await standInShop();
    const { port, edge } = await edgeFor(shop, await standInShop());
    for (const by of ["0", "1,5", "Rp1", "1e3"]) {
      expect(edge.control(["shift", "--next", "--by", by]).ok).toBe(false);
    }
    await call(port, SHOP, "POST", ORDERS, orderBody("ord_plain"));

    expect(JSON.parse(shop.received[0]?.body ?? "{}")).toEqual(JSON.parse(orderBody("ord_plain")));
  });
});

describe("starting the edge", () => {
  const flags = (shopHost: string, shop: string): string[] => [
    "--shop-host",
    shopHost,
    "--shop",
    shop,
    "--dashboard-host",
    DASHBOARD,
    "--dashboard",
    "http://app:3001",
    "--gateway",
    "http://app:3000",
    "--cert",
    "/nonexistent/edge.pem",
    "--key",
    "/nonexistent/edge-key.pem",
    "--port",
    "0",
    "--control-port",
    "0",
  ];

  it.each([
    [
      "a shop name a public resolver may answer",
      "woo.nuanu.ai",
      "http://woo-fault-wordpress",
      "--shop-host",
    ],
    ["a shop reached over TLS", SHOP, "https://woo.nuanu.ai", "--shop,"],
  ])("refuses %s before it listens, naming the flag", async (_case, shopHost, shop, flag) => {
    const lines: string[] = [];
    const started = await serveWooFault(flags(shopHost, shop), (line) => lines.push(line));

    expect(started.ok).toBe(false);
    expect(started.said).toContain(flag);
    expect(lines).toEqual([]);
  });
});
