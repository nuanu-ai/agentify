/**
 * The staple that holds a stranger's agent to our own contract.
 *
 * `buyer.ts` writes one address out as a string, the catalogue's, and reads
 * answers field by field on purpose: it stands in for an agent that has the
 * portal and no package of ours. The cost is drift. Rename the catalogue's
 * address in `API_ROUTES` and nothing tells the buyer.
 *
 * So the contract is imported here, in the test, and the buyer is driven
 * against a loopback server that records the request line; what went on the
 * wire is compared with the table, which catches a rename on either side. The
 * purchase and status addresses, which the buyer does not write, are compared
 * with the addresses the catalogue and the purchase answer named.
 *
 * This file also holds the one distinction no gateway can be made to
 * demonstrate: an answer that arrived and made no sense, against a call that
 * never landed. What well-behaved answers look like is held by the schemas in
 * `@nuanu-ai/agentify-contracts` and by `slice.test.ts`, which buys through a
 * real gateway.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { API_ROUTES, expandPath, MERCHANT_KEY_HEADER } from "@nuanu-ai/agentify-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeBuyer } from "./buyer.js";

/** The same valueless local-devnet key the rest of the slice signs with. */
const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/**
 * The order this server answers for with a proxy's error page instead of a
 * document, so the buyer can be shown one without a proxy in the way.
 */
const KEY_BEHIND_A_BAD_PROXY = "bk_a_proxy_ate_it";

/**
 * Where this server's purchase answer says the order is collected.
 *
 * An address on this same server and deliberately not the contract's status
 * route, so a buyer that went to the route anyway — or built any address of its
 * own from the order identifier — is caught asking somewhere it was never told.
 */
const NAMED_BY_THE_ANSWER = "/where/the/purchase/answer/said/ord_7c1e05";

/** The product whose purchase answer names an order and no address for it. */
const ITEM_WITH_NO_ADDRESS = "itm_answered_without_an_address";

/**
 * The product whose purchase answer names an address on another origin — a
 * second server, on a port of its own, that is not where this buyer buys.
 */
const ITEM_COLLECTED_ELSEWHERE = "itm_collected_on_another_origin";

/**
 * Where this server's catalogue says a product is bought: an address on this
 * same server and deliberately not the contract's purchase route, so a buyer
 * that built the route from the identifier is caught buying somewhere it was
 * never told.
 */
const namedByTheCatalogue = (itemId: string): string =>
  `/where/the/catalogue/said/${itemId}/purchase`;

/** A product as the catalogue lists it, as far as buying it goes. */
const listed = (itemId: string): { readonly purchase_url: string } => ({
  purchase_url: `${baseUrl}${namedByTheCatalogue(itemId)}`,
});

/**
 * The address of an order's status on the server `base` names, spelled by the
 * contract's route table: for the tests below that are about what the buyer
 * does with an answer, not about where the address came from.
 */
const statusAt = (base: string, buyerKey: string): string =>
  `${base}${expandPath(API_ROUTES.get_order_status.path, { buyer_key: buyerKey })}`;

/** One request as it arrived, which is the only thing this file looks at. */
interface Asked {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

const asked: Asked[] = [];

/** What arrived at the second origin, kept apart from what arrived at the first. */
const askedElsewhere: Asked[] = [];

let server: Server;
let elsewhere: Server;
let buyer: ReturnType<typeof makeBuyer>;
let baseUrl: string;
let elsewhereUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    asked.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
    });
    // One order is answered the way something in the middle answers when the
    // gateway is unreachable: a status nobody designed, in HTML.
    if (request.url?.includes(KEY_BEHIND_A_BAD_PROXY) === true) {
      response.statusCode = 502;
      response.setHeader("content-type", "text/html");
      response.end("<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>");
      return;
    }
    // An empty catalog page is the one answer that has to be well formed: the
    // buyer holds that one to the real schema, and a body it will not parse
    // would fail this file for a reason that has nothing to do with addresses.
    //
    // A purchase is answered with an order and, for every product but one, the
    // address it is collected at. That address is the input the collection
    // test hands the buyer, and it is the one answer here whose content an
    // assertion leans on: the promise is that the buyer asks where it was
    // told. The one product answered with no address is the other half — an
    // answer that named nowhere has to come back as naming nowhere.
    //
    // Everything else is answered with an empty object on purpose — no payment
    // challenge, no order status — so that no other assertion here can be
    // satisfied by an answer this file wrote.
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url?.endsWith("/purchase") === true) {
      response.end(
        JSON.stringify(
          request.url.includes(ITEM_WITH_NO_ADDRESS)
            ? { order_id: "ord_7c1e05" }
            : {
                order_id: "ord_7c1e05",
                status_url: `${
                  request.url.includes(ITEM_COLLECTED_ELSEWHERE) ? elsewhereUrl : baseUrl
                }${NAMED_BY_THE_ANSWER}`,
              },
        ),
      );
      return;
    }
    response.end(JSON.stringify(request.url === "/x402/catalog" ? { items: [] } : {}));
  });
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  // The second origin records what reaches it and answers nothing in
  // particular, for the same reason the first answers most calls with an
  // empty object: the one thing asserted about it is who knocked.
  elsewhere = createServer((request, response) => {
    askedElsewhere.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
    });
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  elsewhere.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => elsewhere.once("listening", resolve));
  elsewhereUrl = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;

  buyer = makeBuyer({
    baseUrl,
    privateKey: TEST_BUYER_KEY,
    maxUsd: 50,
  });
});

afterAll(async () => {
  for (const one of [server, elsewhere]) {
    await new Promise<void>((resolve, reject) => {
      one.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

beforeEach(() => {
  asked.length = 0;
  askedElsewhere.length = 0;
});

/** The one request a call made, or a failure naming how many there were. */
const theOne = (): Asked => {
  expect(asked).toHaveLength(1);
  const one = asked[0];
  if (one === undefined) throw new Error("nothing was asked for");
  return one;
};

describe("the addresses this buyer calls", () => {
  it("reads the catalog where the contract publishes it", async () => {
    await buyer.catalog();

    const one = theOne();
    expect(one.method).toBe(API_ROUTES.list_catalog.method);
    expect(one.path).toBe(API_ROUTES.list_catalog.path);
  });

  it("buys at the address the catalogue named, and asks it for a challenge on the method the contract allows", async () => {
    // An agent holding only the catalogue cannot spell the purchase route from
    // an identifier, and neither does this buyer: it buys where the product's
    // purchase_url says.
    const itemId = "itm_9f2c4a";

    await buyer.buy(listed(itemId), { email: "buyer@example.com" });
    const bought = theOne();
    expect(bought.method).toBe(API_ROUTES.purchase_item.method);
    expect(bought.path).toBe(namedByTheCatalogue(itemId));

    // The unpaid read of the price is a GET at the same address, and the table
    // is where that permission lives — a paywall bound to one method makes the
    // resource invisible to the crawlers that list it.
    asked.length = 0;
    // No challenge is answered here, so the buyer refuses rather than inventing
    // one; the request it made on the way is what this test is about.
    await expect(buyer.challenge(listed(itemId))).rejects.toThrow(/PAYMENT-REQUIRED/i);
    const priced = theOne();
    expect(API_ROUTES.purchase_item.also_answers_on).toContain(priced.method);
    expect(priced.path).toBe(bought.path);
  });

  it("collects an order at the address its purchase answer named, and at no address of its own", async () => {
    // The status address is the one this buyer does not write. An agent that
    // was given the portal and no package of ours cannot spell the route from
    // an order identifier, and neither does this one: it asks where the answer
    // to its own purchase said to ask, and a gateway that named the wrong place
    // is a gateway whose orders this buyer cannot collect.
    const bought = await buyer.buy(listed("itm_9f2c4a"), { email: "buyer@example.com" });

    expect(bought.statusUrl).toBe(`${baseUrl}${NAMED_BY_THE_ANSWER}`);

    asked.length = 0;
    await buyer.status(bought.statusUrl ?? "");

    const one = theOne();
    expect(one.method).toBe(API_ROUTES.get_order_status.method);
    expect(one.path).toBe(NAMED_BY_THE_ANSWER);
  });

  it("calls the address exactly as the answer gave it, on whatever origin the answer named", async () => {
    // The address is the answer's whole, host and port included, and not a
    // path to be joined onto wherever this buyer happens to buy. A gateway
    // behind a proxy, or one that serves its agents' door from another host,
    // names an origin the buyer was never pointed at; a buyer that kept its
    // own origin and borrowed only the path would knock on the wrong server
    // and read its refusal as news about a paid order.
    const bought = await buyer.buy(listed(ITEM_COLLECTED_ELSEWHERE), {});

    expect(bought.statusUrl).toBe(`${elsewhereUrl}${NAMED_BY_THE_ANSWER}`);

    asked.length = 0;
    await buyer.status(bought.statusUrl ?? "");

    expect(asked).toStrictEqual([]);
    expect(askedElsewhere.map((one) => [one.method, one.path])).toStrictEqual([
      [API_ROUTES.get_order_status.method, NAMED_BY_THE_ANSWER],
    ]);
  });

  it("reports an answer that named no address as naming none, rather than making one up", async () => {
    // The negative control for the test above. An order identifier is in this
    // answer and an address is not, and the only honest thing to hand the
    // caller is that there is no address — an address built here from the
    // identifier would be a guess, and it would look exactly like being told.
    const bought = await buyer.buy(listed(ITEM_WITH_NO_ADDRESS), {});

    expect(bought.statusUrl).toBeNull();
  });
});

describe("an answer that arrived against a call that never landed", () => {
  it("hands back an answer it cannot read, with the text of it, rather than throwing", async () => {
    // Something between an agent and the gateway can answer with its own error
    // page in HTML. Parsed as a document that throws, it takes down the poll a
    // paid order is being watched through, and the address the buyer owed
    // somebody is never printed. The money has already moved, so an answer
    // nobody can read must come back as one, distinct from an answer saying the
    // purchase is over.
    const seen = await buyer.status(statusAt(baseUrl, KEY_BEHIND_A_BAD_PROXY));

    expect(seen.status).toBe(502);
    // Nothing is invented out of it: no state, no goods.
    expect(seen.state).toBeNull();
    expect(seen.delivered).toBeNull();
    // And nothing is lost either — the text is there to be printed, which is
    // the only way anybody finds out which box in the middle wrote it.
    expect(seen.body).toContain("502 Bad Gateway");
  });

  it("throws where the call never landed at all", async () => {
    // The other half of the split, and the reason the half above is not simply
    // "never throw". A door that answered badly and a door that is gone want
    // different next moves from a caller holding a paid order, so they do not
    // arrive looking alike.
    const nowhere = makeBuyer({
      baseUrl: "http://127.0.0.1:1",
      privateKey: TEST_BUYER_KEY,
      maxUsd: 50,
    });

    await expect(nowhere.status(statusAt("http://127.0.0.1:1", "bk_7c1e05"))).rejects.toThrow(
      /fetch failed/,
    );
  });
});

describe("what this buyer never sends", () => {
  it("carries no merchant key on any call it makes", async () => {
    // An agent has no account, no registration and no key: the catalog and the
    // purchase are open doors, and the order status is proved by the buyer's
    // key in its address. A buyer that sent a key would be walking doors this one is
    // not supposed to have, and nothing else here would notice the status route
    // ending up behind the merchant's door.
    await buyer.catalog();
    await buyer.buy(listed("itm_9f2c4a"), {});
    await buyer.status(statusAt(baseUrl, "bk_7c1e05"));

    expect(asked).toHaveLength(3);
    for (const one of asked) {
      expect(one.headers[MERCHANT_KEY_HEADER]).toBeUndefined();
    }
  });
});
