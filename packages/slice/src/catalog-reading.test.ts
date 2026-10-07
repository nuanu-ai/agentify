/**
 * How the stand's two buyers read a catalog: card by card (ADR-0006 §5).
 *
 * The storefront has no version, so a page can carry a card of a mode these
 * buyers were not built for, or one they cannot read at all. Either is passed
 * over and the rest of the page stays for sale; a buyer that read the page
 * whole would either refuse it over one card or buy a card whose mode it
 * cannot follow.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { publicCardOf } from "@nuanu-ai/agentify-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeBuyer } from "./buyer.js";
import { EUROPE_ESIM } from "./cards.js";
import { makeStandBuyer } from "./stand-buyer.js";

const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const readable = publicCardOf(EUROPE_ESIM, {
  id: "itm_esim_eu",
  as_of: "2026-10-07T09:00:00.000Z",
  seller: { name: "The pilot merchant", site: null },
});

const page = {
  items: [
    { ...readable, id: "itm_by_appointment", fulfillment: "by_appointment" },
    readable,
    { id: "itm_no_price", title: "Nothing else on it" },
  ],
};

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/x402/catalog" ? page : {}));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

describe("a stand buyer reading the catalog", () => {
  it("keeps the card it can buy from and passes over the rest", async () => {
    const buyer = makeBuyer({ baseUrl, privateKey: TEST_BUYER_KEY, maxUsd: 50 });

    expect(await buyer.catalog()).toStrictEqual([readable]);
  });

  it("does the same on the stand's console", async () => {
    const buyer = makeStandBuyer({ baseUrl, privateKey: TEST_BUYER_KEY, maxUsd: 50, fetch });

    expect(await buyer.catalog()).toStrictEqual([readable]);
  });
});
