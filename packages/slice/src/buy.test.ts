/**
 * The buy command, run as the process it is, against a gateway that is not one.
 *
 * `buy.ts` is a script with no function to call: everything it decides happens
 * between its first line and its exit code, and what it decides is what an
 * operator is told about an order that has already been paid for. So it is run
 * here whole, with the one input it takes — `GATEWAY_URL` — pointed at a
 * loopback server that answers the three calls it makes: the catalog, the
 * purchase, and the address the purchase answer named, which answers from a
 * script, one document per ask.
 *
 * The promise is that this buyer does not report an order as over while goods
 * can still arrive. `refund_due` is the word that taught it: an order still
 * without goods at its delivery deadline becomes a debt, the merchant can still
 * deliver after that, and a live run saw exactly that happen — the goods
 * appeared at the status address a minute after the deadline. A buyer that
 * printed "closed" at the debt and left had told its operator the purchase was
 * over while it was still going.
 *
 * The catalog page and every order document this server hands out are held to
 * the contract's schema, so a run that goes wrong here goes wrong for the
 * buyer's reasons and not because this file wrote an answer no gateway would
 * write.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  type AgentOrderStatus,
  AgentOrderStatusSchema,
  CatalogPageSchema,
  publicCardOf,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EUROPE_ESIM } from "./cards.js";

const ITEM = "itm_b47c5b50e4924b9c98f8c9eb10a1e925";
const ORDER = "ord_2923c69f363f4d3088e0c6a3fee8f68d";
const STATUS_PATH = `/x402/orders/${ORDER}/status`;

/** The goods the merchant hands over late, as the live run saw them. */
const GOODS = {
  iccid: "8944001790160048780",
  activation_code: "LPA:1$smdp.example.com$K2-048780",
};

let server: Server | undefined;
let buyer: ChildProcess | undefined;
let base = "";

/** What the status address answers, in order; the last one is repeated. */
let script: AgentOrderStatus[] = [];

/** How many times the status address was asked. */
let asks = 0;

const orderAt = (
  status: AgentOrderStatus["status"],
  delivered: AgentOrderStatus["delivered"] = null,
): AgentOrderStatus =>
  AgentOrderStatusSchema.parse({
    order_id: ORDER,
    status_url: `${base}${STATUS_PATH}`,
    status,
    price: {
      amount: "8.00",
      currency: "USD",
      at: "2026-09-23T10:39:55.784Z",
      as_of: "2026-09-23T10:39:55.750Z",
    },
    delivered,
    test: true,
  });

beforeEach(async () => {
  asks = 0;
  script = [];
  server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drained, so a purchase body is not left on the socket.
    }
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/x402/catalog") {
      response.end(
        JSON.stringify(
          CatalogPageSchema.parse({
            items: [publicCardOf(EUROPE_ESIM, { id: ITEM, as_of: "2026-09-23T10:00:00.000Z" })],
          }),
        ),
      );
      return;
    }
    // No payment challenge: a paid answer is all this command reads from the
    // purchase, and the x402 client passes an answer that is not a 402 through
    // untouched.
    if (request.method === "POST" && request.url === `/x402/${ITEM}/purchase`) {
      response.end(JSON.stringify(orderAt("in_progress")));
      return;
    }
    if (request.method === "GET" && request.url === STATUS_PATH) {
      const next = script.length > 1 ? script.shift() : script[0];
      asks += 1;
      response.end(JSON.stringify(next));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "no_such_route" } }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (buyer !== undefined && buyer.exitCode === null) {
    const exited = new Promise<void>((resolve) => buyer?.once("exit", () => resolve()));
    buyer.kill("SIGTERM");
    await exited;
  }
  buyer = undefined;
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  server = undefined;
});

/** Runs the command to its end and returns what it printed and how it exited. */
const buy = (): Promise<{ readonly code: number | null; readonly printed: string }> =>
  new Promise((resolve, reject) => {
    let printed = "";
    const running = spawn(process.execPath, ["--import", "tsx", "src/buy.ts", "esim"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, GATEWAY_URL: base },
      stdio: ["ignore", "pipe", "pipe"],
    });
    buyer = running;
    running.stdout?.on("data", (chunk) => {
      printed += String(chunk);
    });
    running.stderr?.on("data", (chunk) => {
      printed += String(chunk);
    });
    running.once("error", reject);
    running.once("close", (code) => resolve({ code, printed }));
  });

describe("the buy command watching an order whose goods come later", () => {
  it("keeps watching an order that owes a refund, and collects the goods that arrive after it", async () => {
    script = [orderAt("refund_due"), orderAt("delivered", GOODS)];

    const run = await buy();

    // The goods reached the operator, which only a buyer still watching after
    // the debt could have done: the purchase answer carried none.
    expect(run.printed).toContain(GOODS.iccid);
    expect(run.code).toBe(0);
    expect(asks).toBe(2);
  });

  it("stops at an order that is over, rather than watching it to the ceiling", async () => {
    // The negative control. `refunded` is the debt paid back: a delivery after
    // it is refused, so nothing can arrive and there is nothing to wait for.
    // A buyer that watched every word but `delivered` would sit here for its
    // whole ceiling and then say what it could have said at once.
    script = [orderAt("refunded")];

    const run = await buy();

    expect(run.code).toBe(1);
    expect(run.printed).not.toContain(GOODS.iccid);
    expect(asks).toBe(1);
  });
});
