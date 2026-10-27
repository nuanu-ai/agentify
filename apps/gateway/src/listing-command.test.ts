/**
 * The listing check, tested without the network. The command must never report
 * a pass it did not see: a refused probe, a probe whose endpoint never answered
 * and a probe that came back unreadable are three different things, and only
 * the first says the resource is wrong.
 *
 * The validation endpoint is Coinbase's, so the live call belongs to
 * `pnpm smoke:listing`. The cases at the bottom open a socket only to this
 * process, and stub the probe.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PublicCard } from "@nuanu-ai/agentify-contracts";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DoorAnswer,
  listingCheckOf,
  overTheNetwork,
  type Reach,
  type ValidateAnswer,
} from "./listing-check.js";
import { runListingCheck } from "./listing-command.js";

const card = (id: string): PublicCard => ({
  id,
  purchase_url: `https://agentify.example/x402/${id}/purchase`,
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  as_of: "2026-08-27T09:00:00Z",
  result: { access_code: { type: "string" } },
  price_checked_at_purchase: false,
  seller: { name: "Freeland", site: null },
  fulfillment: "sync",
});

/**
 * A challenge as the door sets it, declaring the method a purchase is made
 * with. Encoded by the same library that reads it, so nothing here is a
 * hand-rolled copy of somebody else's wire format.
 */
const challengeNaming = (method: string): string =>
  encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: "https://agentify.example/x402/itm_1/purchase" },
    accepts: [],
    extensions: { bazaar: { info: { input: { method, bodyType: "json" } } } },
  });

/** A door keeping its promise: a price, and the purchase named as a POST. */
const priced: DoorAnswer = {
  kind: "answered",
  status: 402,
  challenge: challengeNaming("POST"),
};

/** A run: what the ways out answered, and everything the command said. */
function aRun(options: {
  readonly catalog?: { items: PublicCard[] } | Error;
  readonly answers?: (resource: string, method: string) => ValidateAnswer;
  readonly door?: (resource: string) => DoorAnswer;
}) {
  const asked: string[] = [];
  const knocked: string[] = [];
  const said: string[] = [];
  const reach: Reach = {
    catalog: async () => {
      const held = options.catalog ?? { items: [card("itm_1")] };
      if (held instanceof Error) throw held;
      return held;
    },
    validate: async (resource, method) => {
      asked.push(`${method} ${resource}`);
      return options.answers?.(resource, method) ?? { kind: "answered", status: 200, body: {} };
    },
    door: async (resource) => {
      knocked.push(`GET ${resource}`);
      return options.door?.(resource) ?? priced;
    },
  };
  const run = (...argv: string[]) => runListingCheck(argv, reach, (line) => said.push(line));
  return { run, asked, knocked, reach, text: () => said.join("\n") };
}

const accepted: ValidateAnswer = {
  kind: "answered",
  status: 200,
  body: { valid: true, checks: [{ name: "resource.reachable", passed: true }] },
};

describe("asking the catalog whether it would take our resources", () => {
  it("asks about every card on sale, with the purchase's method, at the address the catalog names", async () => {
    // The purchase's method, because that is the one the declaration names and
    // the validator holds the probe to the declaration; asked the other way it
    // answers only that it was asked the other way.
    const run = aRun({
      catalog: { items: [card("itm_1"), card("itm_2")] },
      answers: () => accepted,
    });

    expect(await run.run("https://agentify.example")).toBe(0);
    expect(run.asked).toStrictEqual([
      "POST https://agentify.example/x402/itm_1/purchase",
      "POST https://agentify.example/x402/itm_2/purchase",
    ]);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: true,
      probes: 4,
      refused: [],
      unanswered: [],
      unchecked: [],
    });
  });

  it("asks about the products it was named rather than the whole catalog", async () => {
    const run = aRun({ answers: () => accepted });

    expect(await run.run("https://agentify.example", "itm_9")).toBe(0);
    expect(run.asked).toStrictEqual(["POST https://agentify.example/x402/itm_9/purchase"]);
  });

  it("does not let a trailing slash make a second address for one product", async () => {
    // The address is the identity of a listing. Two spellings would be two
    // listings for one product, and a validation of one says nothing about the
    // other.
    const run = aRun({ answers: () => accepted });

    await run.run("https://agentify.example/", "itm_9");

    expect(run.asked[0]).toBe("POST https://agentify.example/x402/itm_9/purchase");
  });

  it("reports a refusal as a refusal and prints what was said", async () => {
    const run = aRun({
      answers: () => ({
        kind: "answered",
        status: 200,
        body: { valid: false, checks: [{ name: "bazaar.schema", passed: false }] },
      }),
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    // The endpoint's own words, whole. What it checks is theirs and changes
    // when they change it, so nothing here picks the answer apart.
    expect(run.text()).toContain("bazaar.schema");
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      probes: 2,
      refused: ["POST https://agentify.example/x402/itm_1/purchase"],
      unanswered: [],
    });
  });

  it("says nothing was proven when the endpoint could not be reached", async () => {
    // Not a failure of the resource, and not a pass: from a laptop the gateway
    // is not reachable from the internet, and a tick here would claim what
    // nobody saw.
    const run = aRun({
      answers: () => ({ kind: "unreachable", why: "fetch failed: ENOTFOUND" }),
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      probes: 2,
      refused: [],
      unanswered: [expect.stringContaining("ENOTFOUND")],
    });
  });

  it("says nothing was proven when the endpoint answered something else", async () => {
    const run = aRun({
      answers: () => ({ kind: "answered", status: 503, body: "<html>upstream</html>" }),
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      probes: 2,
      refused: [],
      unanswered: [expect.stringContaining("503")],
    });
  });

  it("says nothing was proven when the answer carries no verdict it can read", async () => {
    // The body belongs to somebody else and changes when they change it. An
    // answer this cannot read is a reason to go and look, not a pass.
    const run = aRun({
      answers: () => ({ kind: "answered", status: 200, body: { status: "ok" } }),
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      refused: [],
      unanswered: [expect.any(String)],
    });
  });

  it("does not read a truthy answer as a true one", async () => {
    // `valid: "true"` is a string, and a lenient reading of it would turn an
    // endpoint change into a silent pass.
    const run = aRun({
      answers: () => ({ kind: "answered", status: 200, body: { valid: "true" } }),
    });

    expect(await run.run("https://agentify.example")).toBe(1);
  });

  it("knocks on the door itself, with the plain unpaid GET an agent's own fetch is", async () => {
    // The validator is only ever asked with POST, so nothing in its answer says
    // the deployed door answers a GET at all, and a GET is what an agent
    // reading the resource by hand sends.
    const run = aRun({ answers: () => accepted });

    expect(await run.run("https://agentify.example")).toBe(0);
    expect(run.knocked).toStrictEqual(["GET https://agentify.example/x402/itm_1/purchase"]);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: true,
      probes: 2,
      refused: [],
      unanswered: [],
    });
  });

  it("counts a door that answers an unpaid GET with anything but a price as a refusal", async () => {
    // The goods where a price belongs, or a stub, or a redirect: whatever it
    // is, the deployment is not selling the way the contract says it does. The
    // code path has a test of its own; this is the door that is actually up.
    const run = aRun({
      answers: () => accepted,
      door: () => ({ kind: "answered", status: 200, challenge: null }),
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      refused: [expect.stringContaining("200")],
      unanswered: [],
    });
  });

  it("counts a door whose challenge names GET as the purchase as a refusal", async () => {
    // An agent that pays with the GET such a declaration names gets no order
    // and no receipt, because a GET reads no payment. The validator cannot see
    // this: it is never asked with GET.
    const run = aRun({
      answers: () => accepted,
      door: () => ({ kind: "answered", status: 402, challenge: challengeNaming("GET") }),
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      refused: [expect.stringMatching(/GET.*POST/)],
      unanswered: [],
    });
  });

  it("counts a challenge that names no purchase method at all as a refusal", async () => {
    // A challenge that lost its declaration is a resource no catalog can list
    // and no agent can buy from without guessing.
    const run = aRun({
      answers: () => accepted,
      door: () => ({
        kind: "answered",
        status: 402,
        challenge: encodePaymentRequiredHeader({
          x402Version: 2,
          resource: { url: "https://agentify.example/x402/itm_1/purchase" },
          accepts: [],
        }),
      }),
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      refused: [expect.stringContaining("method")],
      unanswered: [],
    });
  });

  it("says nothing was proven when the door itself could not be reached", async () => {
    // Same line the validator's silence gets: an unreachable door says nothing
    // about the resource behind it.
    const run = aRun({
      answers: () => accepted,
      door: () => ({ kind: "unreachable", why: "fetch failed: ECONNREFUSED" }),
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(run.text()).toContain("ECONNREFUSED");
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      refused: [],
      unanswered: [expect.stringContaining("ECONNREFUSED")],
    });
  });

  it("counts a door whose challenge cannot be read as a refusal", async () => {
    // The door is ours, and it answered: a 402 whose challenge will not decode
    // is a readable answer that breaks the promise — a proxy rewriting the
    // header, a version we stopped speaking — and a finding about our door,
    // not a silence about it. Silence is reserved for a door that never
    // answered at all.
    const run = aRun({
      answers: () => accepted,
      door: () => ({ kind: "answered", status: 402, challenge: "not a challenge" }),
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      refused: [expect.stringMatching(/PAYMENT-REQUIRED.*decode/)],
      unanswered: [],
    });
  });

  it("counts a door that priced nothing to read as a refusal", async () => {
    const run = aRun({
      answers: () => accepted,
      door: () => ({ kind: "answered", status: 402, challenge: null }),
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      refused: [expect.stringContaining("PAYMENT-REQUIRED")],
      unanswered: [],
    });
  });

  it("keeps a refusal and a silence apart in the same run", async () => {
    const run = aRun({
      catalog: { items: [card("itm_1"), card("itm_2")] },
      answers: (resource) =>
        resource.includes("itm_1")
          ? { kind: "answered", status: 200, body: { valid: false } }
          : { kind: "unreachable", why: "timed out" },
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      probes: 4,
      refused: ["POST https://agentify.example/x402/itm_1/purchase"],
      unanswered: [expect.stringContaining("itm_2")],
    });
  });

  it("reports an identifier it cannot build an address from, and keeps going", async () => {
    // An identifier in a catalog may be something no address can be made of,
    // such as a dot, which is a step through a path rather than a value in it.
    // It costs one line of the report, and the products after it are checked.
    const run = aRun({
      catalog: { items: [card("."), card("itm_2")] },
      answers: () => accepted,
    });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(run.asked).toStrictEqual(["POST https://agentify.example/x402/itm_2/purchase"]);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "checked",
      passed: false,
      probes: 2,
      resources: [{ itemId: ".", unbuildable: expect.any(String) }, { itemId: "itm_2" }],
    });
  });

  it("reports an empty catalog as nothing checked rather than as nothing wrong", async () => {
    // Zero resources checked is not zero failures. An empty catalog is exactly
    // the state where every card is paused or none was ever published, and the
    // person running this most needs to be told.
    const run = aRun({ catalog: { items: [] } });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(run.asked).toStrictEqual([]);
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "nothing_on_sale",
    });
  });

  it("reports a catalog it could not read rather than checking nothing quietly", async () => {
    const run = aRun({ catalog: new Error("connect ECONNREFUSED") });

    expect(await run.run("https://agentify.example")).toBe(1);
    expect(run.text()).toContain("ECONNREFUSED");
    expect(await listingCheckOf("https://agentify.example", [], run.reach)).toMatchObject({
      kind: "catalog_unreadable",
      why: "connect ECONNREFUSED",
    });
  });

  it("refuses a base address carrying a query or a fragment rather than probing it", async () => {
    // The same mistake the gateway's own configuration refuses at start-up. A
    // path is joined onto this string, so either one lands in the middle of
    // every resource address, which answers nothing — and asking about that
    // address would produce a refusal that reads as though the product were
    // wrong.
    const run = aRun({ answers: () => accepted });

    expect(await run.run("https://agentify.example/?utm=abc")).toBe(2);
    expect(run.text()).toContain("query");
    expect(run.asked).toStrictEqual([]);
    expect(run.knocked).toStrictEqual([]);

    const hashed = aRun({ answers: () => accepted });
    expect(await hashed.run("https://agentify.example/#top")).toBe(2);
    expect(hashed.text()).toContain("fragment");
    expect(hashed.asked).toStrictEqual([]);
  });

  it("says up front that an address which is not https will get no verdict", async () => {
    // The live endpoint refuses an http resource outright with a 400 and no
    // verdict. Without this line a run against the local sandbox is two
    // identical refusals and no explanation.
    const run = aRun({ answers: () => accepted });

    expect(await run.run("http://localhost:3000", "itm_1")).toBe(0);

    expect(run.text()).toMatch(/https.*public|public.*https/i);
    // A warning and not a refusal: it still asks, and still reports what it got.
    expect(run.asked).toStrictEqual(["POST http://localhost:3000/x402/itm_1/purchase"]);
    const secure = aRun({ answers: () => accepted });
    expect(await secure.run("https://agentify.example", "itm_1")).toBe(0);
    expect(secure.asked).toStrictEqual(["POST https://agentify.example/x402/itm_1/purchase"]);
  });

  it("asks for an address rather than guessing at one", async () => {
    const run = aRun({});

    expect(await run.run()).toBe(2);
    expect(run.text()).toContain("pnpm smoke:listing");
    expect(run.asked).toStrictEqual([]);
  });
});

describe("reading a running gateway over a real socket", () => {
  /**
   * The parts that talk to a gateway: what a catalog answer has to look like,
   * what is printed when it is not one, and whether the door's challenge is
   * really read off the wire. The server is this process, on a port the
   * operating system picks.
   *
   * Only the gateway side is real. A real probe would call Coinbase's
   * validation endpoint on every run of the suite and the cases would pass
   * either way, so nothing would say so.
   */
  let server: Server | null = null;
  /** What actually arrived, so a case can hold the command to the call it made. */
  let arrived: string[] = [];

  const serving = async (answer: {
    readonly status?: number;
    readonly body: string;
    readonly type?: string;
    readonly headers?: Readonly<Record<string, string>>;
  }): Promise<string> => {
    server = createServer((request, response) => {
      arrived.push(`${request.method} ${request.url}`);
      response.writeHead(answer.status ?? 200, {
        "content-type": answer.type ?? "application/json",
        ...answer.headers,
      });
      response.end(answer.body);
    });
    await new Promise<void>((ready) => server?.listen(0, "127.0.0.1", ready));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  };

  afterEach(async () => {
    await new Promise<void>((closed) => {
      if (server === null) return closed();
      server.close(() => closed());
    });
    server = null;
    arrived = [];
  });

  const card = (id: string) => ({
    id,
    title: "A room for the night",
    description: "One night in room 101",
    price: { amount: "80.00", currency: "USD" },
    as_of: "2026-08-27T09:00:00Z",
    result: { access_code: { type: "string" } },
    price_checked_at_purchase: false,
    fulfillment: "sync",
  });

  /**
   * The command reading a catalog for real, with the probe stubbed because the
   * real one leaves this machine.
   */
  const run = async (base: string) => {
    const said: string[] = [];
    const reach: Reach = { ...overTheNetwork(), validate: async () => accepted };
    const code = await runListingCheck([base], reach, (line) => said.push(line));
    return { code, text: said.join("\n") };
  };

  it("takes the identifiers out of a catalog it can read", async () => {
    const base = await serving({ body: JSON.stringify({ items: [card("itm_1")] }) });

    const { code, text } = await run(base);

    // The identifier came off the wire and reached the address a probe is
    // built from, which is the whole of what this way out is for.
    expect(text).toContain(`${base}/x402/itm_1/purchase`);
    expect(code).toBe(1);
    expect(arrived).toStrictEqual(["GET /x402/catalog", "GET /x402/itm_1/purchase"]);
  });

  it("reads a catalog from a gateway newer than this checkout", async () => {
    // The catalog document grows fields (it promises a paging field), and this
    // command runs from a local copy against a deployment that may be ahead of
    // it. Held to the whole document, a good catalog from a newer gateway would
    // be refused, and the command would report that it checked nothing.
    const base = await serving({
      body: JSON.stringify({
        items: [{ ...card("itm_1"), badges: ["new"] }],
        next_page: "cursor-42",
      }),
    });

    const { code, text } = await run(base);

    expect(text).toContain(`${base}/x402/itm_1/purchase`);
    expect(code).toBe(1);
    expect(arrived).toStrictEqual(["GET /x402/catalog", "GET /x402/itm_1/purchase"]);
  });

  it("says what it could not read when something else answers instead", async () => {
    // A proxy, a login page, a maintenance stub: anything answering in front of
    // the gateway gets a sentence, not a stack trace.
    const base = await serving({ body: JSON.stringify({ error: "unauthorized" }) });

    const { code, text } = await run(base);

    expect(code).toBe(1);
    expect(text).toContain("items");
    expect(arrived).toStrictEqual(["GET /x402/catalog"]);
    await expect(overTheNetwork().catalog(base)).rejects.toThrow();
  });

  it("says so when the answer is not JSON at all", async () => {
    const base = await serving({ body: "<html>maintenance</html>", type: "text/html" });

    const { code, text } = await run(base);

    expect(code).toBe(1);
    expect(text).toMatch(/JSON|Unexpected token/i);
    expect(arrived).toStrictEqual(["GET /x402/catalog"]);
  });

  it("names the status when the gateway refuses the catalog", async () => {
    const base = await serving({ status: 503, body: JSON.stringify({ items: [] }) });

    const { code, text } = await run(base);

    expect(code).toBe(1);
    expect(text).toContain("503");
    expect(arrived).toStrictEqual(["GET /x402/catalog"]);
  });

  it("reads the door's own challenge off the wire", async () => {
    // The one part of the GET check no fake can prove: that the command really
    // sends a GET to the resource and really reads the header the door sets on
    // it. Get the header's name wrong and every offline case above still
    // passes, while every run against a deployment reports a door that priced
    // nothing. The catalog is skipped by naming the product, so this server can
    // answer as the door for every request it gets.
    const base = await serving({
      status: 402,
      body: "{}",
      headers: { "PAYMENT-REQUIRED": challengeNaming("POST") },
    });

    const said: string[] = [];
    const reach: Reach = { ...overTheNetwork(), validate: async () => accepted };
    const code = await runListingCheck([base, "itm_1"], reach, (line) => said.push(line));

    expect(code).toBe(0);
    // The request as it left, not as the report describes it: an unpaid GET at
    // the resource's own address, which is the fetch an agent makes.
    expect(arrived).toStrictEqual(["GET /x402/itm_1/purchase"]);
  });
});
