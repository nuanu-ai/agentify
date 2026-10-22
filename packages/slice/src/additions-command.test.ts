/**
 * The additions proxy between a loopback upstream that serves fixed answers
 * and a plain fetch, so what reaches the caller is compared byte for byte with
 * what the upstream sent. The organiser's promise is that each addition
 * reaches the caller where the README says and nowhere else, that every other
 * byte is the upstream's, and that an answer carrying a payment is never
 * rewritten.
 */

import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { runAdditions } from "./additions-command.js";

interface Canned {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body: string | Buffer;
}

const running: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((one) => one.close()));
});

/** An upstream answering each `METHOD path` with its canned answer, and 404 otherwise. */
const upstream = async (answers: Record<string, Canned>): Promise<string> => {
  const server = createServer((request, response: ServerResponse) => {
    request.resume();
    request.on("end", () => {
      const path = (request.url ?? "").split("?", 1)[0];
      const canned = answers[`${request.method} ${path}`];
      if (canned === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(canned.status ?? 200, {
        "content-type": "application/json; charset=utf-8",
        ...canned.headers,
      });
      response.end(canned.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running.push({
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const proxied = async (to: string, ...adds: string[]) => {
  const lines: string[] = [];
  const started = await runAdditions(
    ["--to", to, "--port", "0", ...adds.flatMap((add) => ["--add", add])],
    (line) => lines.push(line),
  );
  if (!started.ok) throw new Error(started.why);
  running.push(started.proxy);
  return { base: `http://127.0.0.1:${started.proxy.port}`, lines };
};

const NOTE = ',"instrument_note":"added by the additions proxy"';

const ORDER =
  '{"id":"ord_1","merchant_item_id":"esim-eu","params":{"email":"buyer@example.com"},"price":{"amount":"8.00","currency":"USD","at":"2026-10-22T09:00:00.000Z"},"test":true}';
const PARCEL =
  '{"id":"ord_2","merchant_item_id":"tote","params":{},"price":{"amount":"15.00","currency":"USD","at":"2026-10-22T09:00:00.000Z"},"ship_to":{"name":"Made Wirawan","line_one":"Jl. Raya Kediri 12","city":"Tabanan","state":"BA","postal_code":"82121","country":"ID","phone_number":"+62 361 555 0101"},"test":true}';
const ERASED =
  '{"id":"ord_3","merchant_item_id":"tote","params":{},"price":{"amount":"15.00","currency":"USD","at":"2026-10-22T09:00:00.000Z"},"ship_to":{"erased_at":"2026-10-22T09:05:00.000Z"},"test":true}';

// Spaced as a gateway would never write it, so that a proxy re-serialising the
// document instead of splicing into it shows.
const POLL = `{"contract_version":"3", "envelopes":[
  {"kind":"order","id":"env_1","sent_at":"2026-10-22T09:00:01.000Z","payload":${ORDER}},
  {"kind":"quote_request","id":"env_2","sent_at":"2026-10-22T09:00:02.000Z","payload":{"merchant_item_id":"esim-eu","price_id":"prc_1","purpose":"purchase","expires_at":"2026-10-22T09:00:32.000Z"}},
  {"kind":"order_event","id":"env_3","sent_at":"2026-10-22T09:00:03.000Z","payload":{"type":"order.unfulfilled","order_id":"ord_9","at":"2026-10-22T09:00:03.000Z","price":{"amount":"8.00","currency":"USD"},"reason":"refused"}}
]}`;

const ADDED_BESIDE = (envelope: string, order: string, at: string) =>
  `,{"kind":"order_event","id":"${envelope}.added","sent_at":"${at}","payload":{"type":"order.added_kind","order_id":"${order}","at":"${at}"}}`;

describe("additions that only inform", () => {
  it("reach a poll's top, its envelopes, its events and its price questions as the README says, and every other byte is the upstream's", async () => {
    const to = await upstream({ "POST /v0/worker/poll": { body: POLL } });
    const { base } = await proxied(to, "field", "event-kind", "event-reason", "quote-purpose");

    const received = await (await fetch(`${base}/v0/worker/poll`, { method: "POST" })).text();
    const document = JSON.parse(received);

    expect(document.instrument_note).toBeDefined();
    const [order, addedBesideOrder, question, event, addedBesideEvent] = document.envelopes;
    for (const envelope of [order, question, event]) expect(envelope.instrument_note).toBeDefined();
    expect(order.payload).not.toHaveProperty("instrument_note");
    expect(question.payload).not.toHaveProperty("instrument_note");
    expect(event.payload.instrument_note).toBeDefined();
    expect(question.payload.purpose).toBe("added_purpose");
    expect(event.payload.reason).toBe("added_reason");
    expect(addedBesideOrder.payload).toEqual({
      type: "order.added_kind",
      order_id: "ord_1",
      at: "2026-10-22T09:00:01.000Z",
    });
    expect(addedBesideEvent.payload.order_id).toBe("ord_9");

    const undone = received
      .replaceAll(NOTE, "")
      .replace(ADDED_BESIDE("env_1", "ord_1", "2026-10-22T09:00:01.000Z"), "")
      .replace(ADDED_BESIDE("env_3", "ord_9", "2026-10-22T09:00:03.000Z"), "")
      .replace('"added_purpose"', '"purchase"')
      .replace('"added_reason"', '"refused"');
    expect(undone).toBe(POLL);
  });

  it("put a status word on every order read and listed, a result word on a delivery, and keep the field off the closed top of an order read", async () => {
    const read = ORDER.replace(
      '"test":true',
      '"test":true,"status":"in_progress","payment_status":"paid"',
    );
    const to = await upstream({
      "GET /v0/orders/ord_1": { body: read },
      "GET /v0/orders": { body: `{"orders":[${read},${read.replace("ord_1", "ord_4")}]}` },
      "POST /v0/orders/ord_1/deliver": { body: '{"ok":true,"result":"delivered"}' },
      "GET /v0/orders/ord_404": {
        status: 404,
        body: '{"error":{"code":"no_such_order","message":"No order is named \\"ord_404\\" here, not even {this}.","retryable":false}}',
      },
      "GET /x402/orders/ord_1/status": {
        body: '{"order_id":"ord_1","status":"in_progress","payment_status":"paid"}',
      },
    });
    const { base } = await proxied(to, "field", "status-word", "result-word");
    const json = async (path: string, method = "GET") =>
      (await (await fetch(`${base}${path}`, { method })).json()) as {
        readonly status?: string;
        readonly instrument_note?: string;
        readonly orders?: readonly { readonly status: string }[];
        readonly error?: unknown;
      };

    const one = await json("/v0/orders/ord_1");
    expect(one.status).toBe("added_status");
    expect(one).not.toHaveProperty("instrument_note");
    const list = await json("/v0/orders");
    expect(list.orders?.map((order) => order.status)).toEqual(["added_status", "added_status"]);
    expect(list.instrument_note).toBeDefined();
    expect(await json("/v0/orders/ord_1/deliver", "POST")).toEqual({
      ok: true,
      result: "added_result",
      instrument_note: "added by the additions proxy",
    });
    const refusal = await json("/v0/orders/ord_404");
    expect(Object.keys(refusal)).toEqual(["error"]);
    expect(refusal.error).toEqual({
      code: "no_such_order",
      message: 'No order is named "ord_404" here, not even {this}.',
      retryable: false,
      instrument_note: "added by the additions proxy",
    });
    expect((await json("/x402/orders/ord_1/status")).status).toBe("added_status");
  });

  it("narrowed to a path pattern, reach only the answers whose path it matches", async () => {
    const read = '{"id":"ord_1","status":"in_progress"}';
    const to = await upstream({
      "GET /v0/orders": { body: `{"orders":[${read}]}` },
      "GET /v0/orders/ord_1": { body: read },
    });
    const { base } = await proxied(to, "status-word@/v0/orders");

    expect(await (await fetch(`${base}/v0/orders/ord_1`)).text()).toBe(read);
    const listed = (await (await fetch(`${base}/v0/orders`)).json()) as {
      orders: { status: string }[];
    };
    expect(listed.orders[0]?.status).toBe("added_status");
  });
});

describe("additions to what an order delivers", () => {
  it("add a field to each order's core and give a parcel's address a new shape, leaving an erased address and an order with none", async () => {
    const poll = `{"contract_version":"3","envelopes":[${[ORDER, PARCEL, ERASED]
      .map(
        (payload, at) =>
          `{"kind":"order","id":"env_${at}","sent_at":"2026-10-22T09:00:00.000Z","payload":${payload}}`,
      )
      .join(",")}]}`;
    const to = await upstream({ "POST /v0/worker/poll": { body: poll } });
    const { base } = await proxied(to, "delivery-field", "address-shape");

    const received = await (await fetch(`${base}/v0/worker/poll`, { method: "POST" })).text();
    const [plain, parcel, erased] = JSON.parse(received).envelopes.map(
      (envelope: { payload: Record<string, unknown> }) => envelope.payload,
    );

    expect([plain.quantity, parcel.quantity, erased.quantity]).toEqual([3, 3, 3]);
    expect(parcel.ship_to).toEqual({
      pickup_point: "added_pickup_point",
      city: "Tabanan",
      state: "BA",
      postal_code: "82121",
      country: "ID",
    });
    expect(erased.ship_to).toEqual({ erased_at: "2026-10-22T09:05:00.000Z" });
    expect(plain).not.toHaveProperty("ship_to");
  });

  it("are refused beside additions that only inform", async () => {
    const started = await runAdditions(
      ["--to", "http://127.0.0.1:1", "--add", "field", "--add", "address-shape"],
      () => {},
    );
    expect(started).toEqual({
      ok: false,
      why: expect.stringContaining("address-shape cannot run beside field"),
    });
  });
});

describe("what is never rewritten", () => {
  it("passes a purchase's challenge, a purchase's answer and the catalog byte for byte with every addition that could reach them", async () => {
    const challenge = { "payment-required": "eyJ4NDAyVmVyc2lvbiI6Mn0=" };
    const answers: Record<string, Canned> = {
      "GET /x402/item_1/purchase": { status: 402, headers: challenge, body: "{}" },
      "POST /x402/item_1/purchase": {
        headers: { "payment-response": "eyJzdWNjZXNzIjp0cnVlfQ==" },
        body: '{"order_id":"ord_1","status":"delivered","payment_status":"paid"}',
      },
      "GET /x402/catalog": { body: '{"items":[]}' },
    };
    const to = await upstream(answers);
    const { base, lines } = await proxied(to, "field", "status-word");

    for (const [key, canned] of Object.entries(answers)) {
      const [method, path] = key.split(" ");
      const response = await fetch(`${base}${path}`, { method });
      expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(canned.body))).toBe(true);
      for (const [name, value] of Object.entries(canned.headers ?? {})) {
        expect(response.headers.get(name)).toBe(value);
      }
    }
    const logged = lines.filter((line) => / #\d+ \w+ \/x402\//.test(line));
    expect(logged).toHaveLength(3);
    for (const line of logged) expect(line).toMatch(/: passed through$/);
  });

  it("passes an answer carrying a payment challenge or settlement unchanged on a route an addition reaches", async () => {
    const body = '{"order_id":"ord_1","status":"in_progress"}';
    const to = await upstream({
      "GET /x402/orders/ord_1/status": {
        headers: { "payment-response": "eyJzdWNjZXNzIjp0cnVlfQ==" },
        body,
      },
    });
    const { base, lines } = await proxied(to, "field", "status-word");

    expect(await (await fetch(`${base}/x402/orders/ord_1/status`)).text()).toBe(body);
    expect(lines.at(-1)).toContain("never rewrites");
  });

  it("refuses a rule whose pattern could reach the purchase or the catalog, and one that reaches none of its answers", async () => {
    const refusal = async (add: string) => {
      const started = await runAdditions(["--to", "http://127.0.0.1:1", "--add", add], () => {});
      return started.ok ? "started" : started.why;
    };
    expect(await refusal("field@/x402/*/purchase")).toContain("never rewrites them");
    expect(await refusal("field@/*/*")).toContain("GET /x402/catalog");
    expect(await refusal("status-word@/v0/cards")).toContain("matches none of the answers");
  });
});

describe("an encoded answer", () => {
  it("is sent decoded, without its coding or entity tag, once something is added to it, and is passed as it came otherwise", async () => {
    const encoded = gzipSync(Buffer.from('{"ok":true,"result":"delivered"}'));
    const headers = { "content-encoding": "gzip", etag: 'W/"20-x"' };
    const to = await upstream({
      "POST /v0/orders/ord_1/deliver": { headers, body: encoded },
      "POST /v0/orders/ord_1/accept": { headers, body: encoded },
    });
    const { base } = await proxied(to, "result-word");

    const rewritten = await fetch(`${base}/v0/orders/ord_1/deliver`, { method: "POST" });
    expect(rewritten.headers.get("content-encoding")).toBeNull();
    expect(rewritten.headers.get("etag")).toBeNull();
    expect(await rewritten.text()).toBe('{"ok":true,"result":"added_result"}');

    const untouched = await fetch(`${base}/v0/orders/ord_1/accept`, {
      method: "POST",
      headers: { "accept-encoding": "identity" },
    });
    expect(untouched.headers.get("etag")).toBe('W/"20-x"');
  });
});

describe("the log", () => {
  it("names each addition, where it went and the order it touched, and prints no header or body", async () => {
    const to = await upstream({ "POST /v0/worker/poll": { body: POLL } });
    const { base, lines } = await proxied(to, "field", "event-kind");

    await fetch(`${base}/v0/worker/poll`, {
      method: "POST",
      headers: { authorization: "Bearer csk_test_a-key-that-must-not-show" },
    });
    const line = lines.at(-1) ?? "";

    expect(line).toContain("POST /v0/worker/poll 200");
    expect(line).toContain("field (envelope ×3; event; top)");
    expect(line).toContain(
      "event-kind (beside the order of order ord_1; beside the event of order ord_9)",
    );
    expect(line).not.toContain("csk_test");
    expect(line).not.toContain("buyer@example.com");
  });
});
