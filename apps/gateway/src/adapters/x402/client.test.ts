/**
 * The facilitator client, against a facilitator that is really there. Every
 * test stands a server up on 127.0.0.1 and lets the official client make a real
 * request to it: only that checks that the configured credentials arrive at the
 * far end, in the right header, on the request carrying the payment. A fake
 * asserting call arguments would pass with the wrong header name.
 *
 * Coinbase's facilitator, which no test reaches, is stood in for the same way:
 * a server on 127.0.0.1 that checks a token as Coinbase does, behind a fetch
 * that sends Coinbase's address there.
 *
 * The address is given by name, never left to `listen(0)` alone: a bare
 * `listen(0)` takes the port on the IPv6 wildcard and leaves it free on
 * 127.0.0.1, which the calls below name.
 */

import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { format } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { nobodyAnnounces } from "../../ports/announcer.js";
import { startGateway } from "../../start.js";
import { loggedWhile } from "../../testing/harness.js";
import {
  cdpAuthenticatedClient,
  facilitatorClientFor,
  refuseUnlessCoinbaseTakesTheKey,
  refuseUnlessCredentialsSign,
} from "./client.js";

interface ApiKey {
  readonly id: string;
  readonly secret: string;
  /** The half Coinbase keeps, which a stand-in checks signatures with. */
  readonly publicKey: KeyObject;
}

/**
 * A CDP API key of the shape the signer takes, made here and never written
 * down: the secret is sixty-four bytes of base64, the Ed25519 seed followed by
 * its public key. It opens nothing — no test in this file speaks to Coinbase —
 * and generating it is what keeps a credential-shaped string out of the
 * repository.
 */
const anApiKey = (id = "an-api-key"): ApiKey => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const published = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { id, secret: Buffer.concat([seed, published]).toString("base64"), publicKey };
};

const anApiKeySecret = (): string => anApiKey().secret;

interface Arrived {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | undefined;
}

interface Standing {
  readonly url: string;
  readonly arrived: Arrived[];
  /** What the next request to this path is answered with. */
  answer(path: string, status: number, body: unknown): void;
}

const standing: Server[] = [];

afterEach(async () => {
  await Promise.all(
    standing.splice(0).map((server) => new Promise<void>((closed) => server.close(() => closed()))),
  );
});

/** A facilitator that records what reached it and answers what a test says. */
const aFacilitator = async (): Promise<Standing> => {
  const arrived: Arrived[] = [];
  const answers = new Map<string, { status: number; body: unknown }>();

  const server = createServer((request, response) => {
    const path = request.url ?? "";
    arrived.push({
      path,
      method: request.method ?? "",
      authorization: request.headers.authorization,
    });
    // The body is read and dropped: nothing here judges a payment, and a
    // request left unread keeps the socket open.
    request.resume();
    request.on("end", () => {
      const scripted = answers.get(path) ?? { status: 200, body: { isValid: true } };
      response.writeHead(scripted.status, { "content-type": "application/json" });
      response.end(JSON.stringify(scripted.body));
    });
  });

  standing.push(server);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((ready) => server.once("listening", () => ready()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    arrived,
    answer: (path, status, body) => answers.set(path, { status, body }),
  };
};

/** An address on the loopback interface with nothing behind it. */
const NOWHERE = "http://127.0.0.1:1";

const aPayment = (overrides: Partial<Parameters<typeof facilitatorClientFor>[0]> = {}) => ({
  facilitatorUrl: "https://x402.org/facilitator",
  network: "eip155:84532",
  timeoutSeconds: 300,
  payTo: null,
  cdpApiKeyId: null,
  cdpApiKeySecret: null,
  ...overrides,
});

const aPayload = { x402Version: 2, scheme: "exact", payload: { signature: "0xsigned" } };
const aRequirement = { scheme: "exact", network: "eip155:84532", amount: "1" };

/** The claims a signed token carries, read the way any reader of it would. */
const claimsOf = (authorization: string): Record<string, unknown> => {
  const token = authorization.replace(/^Bearer /, "");
  const [, claims = ""] = token.split(".");
  return JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
};

const COINBASE = "https://api.cdp.coinbase.com";
const COINBASE_FACILITATOR = `${COINBASE}/platform/v2/x402`;
const VERIFY = "/platform/v2/x402/verify";

/** In every body the stand-in Coinbase sends, so a test can see whether one was passed on. */
const COINBASE_SAID = "correlation-7c1d-said-by-coinbase";

/**
 * Whether a bearer token is one this key signed for this one request and has
 * not expired, checked as Coinbase checks it: the signature against the public
 * half, the key named, and the method, host and path the token is good for.
 */
const signedFor = (authorization: string, key: ApiKey, uri: string): boolean => {
  if (!authorization.startsWith("Bearer ")) {
    return false;
  }
  const [header = "", claims = "", signature = ""] = authorization.slice(7).split(".");
  try {
    const read = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
    return (
      verify(
        null,
        Buffer.from(`${header}.${claims}`),
        key.publicKey,
        Buffer.from(signature, "base64url"),
      ) &&
      read.sub === key.id &&
      read.exp > Date.now() / 1000 &&
      JSON.stringify(read.uris) === JSON.stringify([uri])
    );
  } catch {
    return false;
  }
};

interface StandInCoinbase {
  /** The network as the gateway's fetch meets it, with Coinbase's host answered here. */
  readonly fetch: typeof fetch;
  readonly arrived: Arrived[];
  /** What every request to this path is answered with, whatever key it carries. */
  answer(path: string, status: number, headers?: Record<string, string>): void;
}

/**
 * Coinbase's facilitator as the start check meets it, behaving as Coinbase was
 * seen to behave: a request to verify the empty payment `{"x402Version":2}`,
 * signed with the key it knows for that very method, host and path, is turned
 * down as a bad request (400, `invalid_request`) — the key is good, the
 * payment is not — and anything else, a key it does not know above all, is
 * answered 401. The fetch it hands out sends Coinbase's address to it, as a
 * hosts-file entry would, so every request is a real one on a real socket and
 * a redirect is followed or not by the real fetch.
 */
const aCoinbase = async (knows: ApiKey): Promise<StandInCoinbase> => {
  // Read now: a test may put this stand-in's own fetch in the global's place.
  const network = globalThis.fetch;
  const arrived: Arrived[] = [];
  const scripted = new Map<string, { status: number; headers: Record<string, string> }>();

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      const authorization = request.headers.authorization;
      arrived.push({ path, method: request.method ?? "", authorization });
      const takes =
        request.method === "POST" &&
        path === VERIFY &&
        request.headers["content-type"] === "application/json" &&
        Buffer.concat(chunks).toString("utf8") === '{"x402Version":2}' &&
        signedFor(authorization ?? "", knows, `POST api.cdp.coinbase.com${VERIFY}`);
      const answer = scripted.get(path) ?? { status: takes ? 400 : 401, headers: {} };
      response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      response.end(
        JSON.stringify({
          errorType: takes ? "invalid_request" : "unauthorized",
          correlationId: COINBASE_SAID,
        }),
      );
    });
  });

  standing.push(server);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((ready) => server.once("listening", () => ready()));
  const { port } = server.address() as AddressInfo;

  return {
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      network(String(input).replace(COINBASE, `http://127.0.0.1:${port}`), init)) as typeof fetch,
    arrived,
    answer: (path, status, headers = {}) => scripted.set(path, { status, headers }),
  };
};

/**
 * A fetch whose request never reaches Coinbase, failing the way Node's fetch
 * fails. The token it was handed is kept, for the test that looks for it in
 * what the gateway says.
 */
const failingWith = (failure: Error, handed: string[] = []): typeof fetch =>
  (async (_input: string | URL | Request, init?: RequestInit) => {
    handed.push(new Headers(init?.headers).get("authorization") ?? "");
    throw failure;
  }) as typeof fetch;

/** The client a deployment builds for Coinbase's facilitator with this key. */
const coinbaseClientWith = (key: Pick<ApiKey, "id" | "secret">) =>
  facilitatorClientFor(
    aPayment({
      facilitatorUrl: COINBASE_FACILITATOR,
      cdpApiKeyId: key.id,
      cdpApiKeySecret: key.secret,
    }),
  );

/** What a promise was rejected with; a promise that resolves fails the test. */
const refusalOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    (resolved) => {
      throw new Error(`expected a refusal, and it resolved with ${String(resolved)}`);
    },
    (thrown: unknown) => thrown,
  );

describe("talking to a facilitator that takes credentials", () => {
  it("signs every call for the address and the method it is actually made on", async () => {
    // The promise: a gateway configured with CDP credentials has them on the
    // wire, in the header the facilitator reads, bound to the request being
    // made. The binding is the part worth checking — the token names the method,
    // the host and the path it is good for, so a token signed for the wrong one
    // of the three is refused by the far end and the gateway settles nothing.
    const facilitator = await aFacilitator();
    const client = cdpAuthenticatedClient(facilitator.url, "an-api-key", anApiKeySecret());
    const host = new URL(facilitator.url).host;

    await client.verify(aPayload as never, aRequirement as never);
    facilitator.answer("/settle", 200, { success: true, transaction: "0xtx", network: "eip155:1" });
    await client.settle(aPayload as never, aRequirement as never);

    const [verified, settled] = facilitator.arrived;
    expect(verified?.authorization).toMatch(/^Bearer \S+$/);
    expect(claimsOf(verified?.authorization ?? "").uris).toStrictEqual([`POST ${host}/verify`]);
    expect(claimsOf(settled?.authorization ?? "").uris).toStrictEqual([`POST ${host}/settle`]);

    // The key it was signed with is the caller's, not one read out of the
    // ambient environment behind their back.
    expect(claimsOf(verified?.authorization ?? "").sub).toBe("an-api-key");
  });

  it("signs for the path the facilitator actually lives under", async () => {
    // Coinbase's facilitator is mounted under a path, and the token names the
    // whole of it. A token signed for `/verify` when the request goes to
    // `/platform/v2/x402/verify` is a token the far end refuses, and the whole
    // deployment settles nothing while looking configured.
    const facilitator = await aFacilitator();
    const client = cdpAuthenticatedClient(
      `${facilitator.url}/platform/v2/x402`,
      "an-api-key",
      anApiKeySecret(),
    );

    await client.verify(aPayload as never, aRequirement as never);

    const asked = facilitator.arrived[0];
    expect(asked?.path).toBe("/platform/v2/x402/verify");
    expect(claimsOf(asked?.authorization ?? "").uris).toStrictEqual([
      `POST ${new URL(facilitator.url).host}/platform/v2/x402/verify`,
    ]);
  });

  it("signs for the path a trailing slash would otherwise double", async () => {
    // A base written with a trailing slash is the same facilitator, and the
    // client strips it before building the address. The token has to be signed
    // against the address that is actually requested, not the one configured.
    const facilitator = await aFacilitator();
    const client = cdpAuthenticatedClient(
      `${facilitator.url}/x402/`,
      "an-api-key",
      anApiKeySecret(),
    );

    await client.verify(aPayload as never, aRequirement as never);

    const asked = facilitator.arrived[0];
    expect(asked?.path).toBe("/x402/verify");
    expect(claimsOf(asked?.authorization ?? "").uris).toStrictEqual([
      `POST ${new URL(facilitator.url).host}/x402/verify`,
    ]);
  });
});

describe("choosing a facilitator client for a configuration", () => {
  it("sends nothing to a facilitator that is not Coinbase's, credentials or no credentials", async () => {
    // The security promise, and the reason the fork is on the address rather
    // than on whether credentials happen to be set. Credentials left in an
    // environment beside somebody else's facilitator must not be handed to it:
    // a bearer token is a key, and this one is good for the account it came
    // from and not for the host it is sent to.
    const facilitator = await aFacilitator();
    const client = facilitatorClientFor(
      aPayment({
        facilitatorUrl: facilitator.url,
        cdpApiKeyId: "an-api-key",
        cdpApiKeySecret: anApiKeySecret(),
      }),
    );

    await client.verify(aPayload as never, aRequirement as never);

    expect(facilitator.arrived[0]?.authorization).toBeUndefined();
  });

  it("signs for Coinbase's facilitator, and names it by host rather than by one spelling", async () => {
    // No request is made here and none can be: reaching Coinbase is exactly what
    // this suite does not do. What is read instead is what the client would put
    // on the request, which is the library's own way of asking.
    const signed = facilitatorClientFor(
      aPayment({
        facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
        cdpApiKeyId: "an-api-key",
        cdpApiKeySecret: anApiKeySecret(),
      }),
    );

    const { headers } = await signed.createAuthHeaders("verify");
    expect(headers.Authorization).toMatch(/^Bearer \S+$/);
    expect(claimsOf(headers.Authorization ?? "").uris).toStrictEqual([
      "POST api.cdp.coinbase.com/platform/v2/x402/verify",
    ]);

    // The same host with a trailing root dot, a spelling deployments use, read
    // through `loadConfig`, where the two spellings become one. The HTTP client
    // puts this string's host in the `Host` header, so a token signed for the
    // other spelling is refused by the facilitator, every verify comes back
    // "unknown", and the agent retries a purchase that can never complete.
    const rooted = facilitatorClientFor(
      loadConfig({
        DATABASE_URL: "postgres://agentify:secret@localhost:5432/agentify",
        FACILITATOR_URL: "https://api.cdp.coinbase.com./platform/v2/x402",
        CDP_API_KEY_ID: "an-api-key",
        CDP_API_KEY_SECRET: anApiKeySecret(),
      }).payment,
    );
    expect(
      claimsOf((await rooted.createAuthHeaders("verify")).headers.Authorization ?? "").uris,
    ).toStrictEqual(["POST api.cdp.coinbase.com/platform/v2/x402/verify"]);

    const unsigned = facilitatorClientFor(aPayment());
    expect((await unsigned.createAuthHeaders("verify")).headers.Authorization).toBeUndefined();
  });

  it("will not start on a credential that is there but cannot sign", async () => {
    // Being set is not the same as being usable, and the difference is a whole
    // deployment. A truncated paste of a CDP secret passes every check that
    // asks whether the variable exists, and then fails inside the signer on
    // every call — so the gateway comes up healthy, takes purchases, and turns
    // each one into "nobody knows" with nothing anywhere saying why. It costs
    // one signature to find out, and no network: the proof is local arithmetic.
    const client = facilitatorClientFor(
      aPayment({
        facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
        cdpApiKeyId: "an-api-key",
        cdpApiKeySecret: `${anApiKeySecret().slice(0, 20)}`,
      }),
    );

    await expect(refuseUnlessCredentialsSign(client)).rejects.toThrow(/CDP_API_KEY_SECRET/);
  });

  it("lets a credential that can sign through, and asks nothing of one that signs nothing", async () => {
    const signing = facilitatorClientFor(
      aPayment({
        facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
        cdpApiKeyId: "an-api-key",
        cdpApiKeySecret: anApiKeySecret(),
      }),
    );
    await expect(refuseUnlessCredentialsSign(signing)).resolves.toBeUndefined();

    // A facilitator that takes no credentials has none to prove, and the same
    // check has to pass it rather than being something only CDP deployments run.
    await expect(
      refuseUnlessCredentialsSign(facilitatorClientFor(aPayment())),
    ).resolves.toBeUndefined();
  });

  it("will not build an unauthenticated client for a facilitator that takes no request without one", async () => {
    // The configuration refuses this deployment at startup, so nothing in the
    // running gateway reaches here. It is a second lock on the same door,
    // because this function can be called by anything in the process and a
    // client built without credentials would fail silently at the first charge
    // rather than loudly here.
    expect(() =>
      facilitatorClientFor(
        aPayment({ facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402" }),
      ),
    ).toThrowError(/CDP_API_KEY/);
  });
});

describe("showing the key to Coinbase before the gateway starts", () => {
  it("lets the gateway start on a key Coinbase takes, with nothing to say about it", async () => {
    // Coinbase answers an empty payment signed with a key it knows with 400,
    // which is the answer that proves the key: taken for anything but that,
    // a healthy key would stop every start or fill every log with a doubt.
    const key = anApiKey();
    const coinbase = await aCoinbase(key);

    await expect(
      refuseUnlessCoinbaseTakesTheKey(coinbaseClientWith(key), coinbase.fetch),
    ).resolves.toBeNull();
    expect(coinbase.arrived).toHaveLength(1);
  });

  it("takes the other answers Coinbase may give an empty payment as taking the key", async () => {
    // A refusal of the payment in its other spelling, and a payment accepted,
    // both say the key was let in.
    const key = anApiKey();
    const coinbase = await aCoinbase(key);

    for (const status of [422, 200]) {
      coinbase.answer(VERIFY, status);
      await expect(
        refuseUnlessCoinbaseTakesTheKey(coinbaseClientWith(key), coinbase.fetch),
      ).resolves.toBeNull();
    }
  });

  it("will not start on a key Coinbase does not know, and names both variables", async () => {
    // A key revoked or deleted at Coinbase is still well formed and still
    // signs, so every local check passes it, and the first buyer would be the
    // one to find out. Coinbase knows a key with the same name and another
    // secret, as after a key is deleted and a new one made under its name.
    const coinbase = await aCoinbase(anApiKey());

    const refusal = String(
      await refusalOf(
        refuseUnlessCoinbaseTakesTheKey(coinbaseClientWith(anApiKey()), coinbase.fetch),
      ),
    );

    expect(refusal).toContain("CDP_API_KEY_ID");
    expect(refusal).toContain("CDP_API_KEY_SECRET");
    expect(refusal).toMatch(/\b401\b/);
  });

  it("will not start where Coinbase forbids the key, as an allowlist without this server does", async () => {
    const key = anApiKey();
    const coinbase = await aCoinbase(key);
    coinbase.answer(VERIFY, 403);

    const refusal = String(
      await refusalOf(refuseUnlessCoinbaseTakesTheKey(coinbaseClientWith(key), coinbase.fetch)),
    );

    expect(refusal).toContain("CDP_API_KEY_ID");
    expect(refusal).toContain("CDP_API_KEY_SECRET");
    expect(refusal).toMatch(/\b403\b/);
  });

  it("starts when Coinbase fails inside itself, with one line saying the key is unconfirmed", async () => {
    // Coinbase being down says nothing about the key, and somebody else's
    // outage must not keep a storefront from starting; the line is there so
    // that silence is never read as "the key is fine".
    const key = anApiKey();
    const coinbase = await aCoinbase(key);
    coinbase.answer(VERIFY, 503);

    const unconfirmed = await refuseUnlessCoinbaseTakesTheKey(
      coinbaseClientWith(key),
      coinbase.fetch,
    );

    expect(unconfirmed).toMatch(/\b503\b/);
    expect(unconfirmed).not.toMatch(/\n/);
  });

  it("starts when Coinbase cannot be reached or does not answer in time, and says which", async () => {
    // What fetch threw is not printed: its message and its cause are the
    // runtime's words about the socket, and the line is the gateway's own.
    const key = anApiKey();
    const unreached = await refuseUnlessCoinbaseTakesTheKey(
      coinbaseClientWith(key),
      failingWith(new TypeError("fetch failed: the-runtime-said-this")),
    );
    const unanswered = await refuseUnlessCoinbaseTakesTheKey(
      coinbaseClientWith(key),
      failingWith(new DOMException("the-runtime-said-that", "TimeoutError")),
    );

    expect(unreached).toEqual(expect.any(String));
    expect(unanswered).toEqual(expect.any(String));
    expect(unanswered).not.toBe(unreached);
    expect(unanswered).toMatch(/\b10 seconds\b/);
    for (const line of [unreached, unanswered]) {
      expect(line).not.toMatch(/the-runtime-said|\n/);
    }
  });

  it("does not follow a redirect with the token on it", async () => {
    // A token is good for two minutes to whoever holds it. Wherever a
    // redirect points, the token stays with the address it was signed for,
    // and the answer is no answer about the key.
    const key = anApiKey();
    const coinbase = await aCoinbase(key);
    coinbase.answer(VERIFY, 307, { location: "/platform/v2/x402/elsewhere" });

    const unconfirmed = await refuseUnlessCoinbaseTakesTheKey(
      coinbaseClientWith(key),
      coinbase.fetch,
    );

    expect(unconfirmed).toMatch(/\b307\b/);
    expect(coinbase.arrived.map(({ path }) => path)).toStrictEqual([VERIFY]);
  });

  it("asks nothing of a facilitator that is not Coinbase's, credentials or no credentials", async () => {
    // Credentials go to Coinbase and nowhere else, and a facilitator that
    // takes none has no key to prove.
    const facilitator = await aFacilitator();
    const client = facilitatorClientFor(
      aPayment({
        facilitatorUrl: facilitator.url,
        cdpApiKeyId: "an-api-key",
        cdpApiKeySecret: anApiKeySecret(),
      }),
    );

    await expect(refuseUnlessCoinbaseTakesTheKey(client, fetch)).resolves.toBeNull();
    expect(facilitator.arrived).toStrictEqual([]);
  });

  it("never carries the key, its name, the token or Coinbase's answer into what it says", async () => {
    // A refusal is printed whole by the process's entry point, the way
    // `format` renders it here, causes and all, and the line goes to the log;
    // both are kept further than anything the gateway erases. The key's name
    // is one nothing would print by chance.
    const name = "organizations/the-name-of-this-key/apiKeys/7f3e";
    const known = anApiKey(name);
    const deleted = anApiKey(name);
    const truncated = known.secret.slice(0, 20);
    const coinbase = await aCoinbase(known);
    const handed: string[] = [];
    const said: string[] = [];

    said.push(
      format(
        await refusalOf(
          refuseUnlessCoinbaseTakesTheKey(coinbaseClientWith(deleted), coinbase.fetch),
        ),
      ),
    );
    coinbase.answer(VERIFY, 403);
    said.push(
      format(
        await refusalOf(refuseUnlessCoinbaseTakesTheKey(coinbaseClientWith(known), coinbase.fetch)),
      ),
    );
    coinbase.answer(VERIFY, 503);
    said.push(
      String(await refuseUnlessCoinbaseTakesTheKey(coinbaseClientWith(known), coinbase.fetch)),
    );
    said.push(
      String(
        await refuseUnlessCoinbaseTakesTheKey(
          coinbaseClientWith(known),
          failingWith(new TypeError("fetch failed"), handed),
        ),
      ),
    );
    said.push(
      format(
        await refusalOf(
          refuseUnlessCoinbaseTakesTheKey(
            coinbaseClientWith({ id: name, secret: truncated }),
            coinbase.fetch,
          ),
        ),
      ),
    );

    const tokens = [...coinbase.arrived.map(({ authorization }) => authorization ?? ""), ...handed];
    expect(tokens).toHaveLength(4);
    const parts = tokens.flatMap((token) => token.replace(/^Bearer /, "").split("."));
    for (const text of said) {
      for (const secret of [known.secret, deleted.secret, truncated, name, COINBASE_SAID]) {
        expect(text).not.toContain(secret);
      }
      for (const part of parts) {
        expect(text).not.toContain(part);
      }
    }
  });
});

describe("the gateway's start on Coinbase's facilitator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A deployment on Coinbase's facilitator whose database does not answer:
   * nothing listens on port 1, so a start that gets past the key fails at
   * the database at once, and says so.
   */
  const onCoinbase = (key: ApiKey) =>
    loadConfig({
      DATABASE_URL: "postgres://agentify@127.0.0.1:1/agentify",
      FACILITATOR_URL: COINBASE_FACILITATOR,
      CDP_API_KEY_ID: key.id,
      CDP_API_KEY_SECRET: key.secret,
    });

  it("stops before anything else when Coinbase refuses the key", async () => {
    const coinbase = await aCoinbase(anApiKey());
    vi.stubGlobal("fetch", coinbase.fetch);

    await expect(startGateway(onCoinbase(anApiKey()), nobodyAnnounces)).rejects.toThrow(
      /CDP_API_KEY_ID/,
    );
  });

  it("goes on when Coinbase cannot say, and says in its log that the key is unconfirmed", async () => {
    const key = anApiKey();
    const coinbase = await aCoinbase(key);
    coinbase.answer(VERIFY, 503);
    vi.stubGlobal("fetch", coinbase.fetch);

    const written = await loggedWhile(async () => {
      await expect(startGateway(onCoinbase(key), nobodyAnnounces)).rejects.toBeDefined();
    });

    expect(written).toMatch(/^\[gateway\] .*\b503\b/m);
    // The database is named only once the start has got past the key.
    expect(written).toContain("127.0.0.1:1/agentify");
  });
});

describe("a facilitator that is not answering", () => {
  it("is built without being asked anything, so an outage cannot stop the process starting", async () => {
    // Somebody else's outage must not kill the storefront, so the payment
    // layer is built from configuration alone and nothing is asked of the
    // facilitator until there is a payment to ask about. The one question at
    // start, Coinbase's look at its key, lets an outage through as well
    // (above).
    const facilitator = await aFacilitator();

    const client = facilitatorClientFor(aPayment({ facilitatorUrl: facilitator.url }));
    expect(facilitator.arrived).toStrictEqual([]);

    // And it is a working client, not an inert one: the first request is the
    // first request, and it goes.
    await client.verify(aPayload as never, aRequirement as never);
    expect(facilitator.arrived).toHaveLength(1);
  });

  it("fails the call and not the process when nothing is listening", async () => {
    // A facilitator that cannot be reached is one call that could not be
    // answered. The client raises, the adapter above turns that into a silence
    // the order machine has a word for, and the process carries on — the second
    // call proves the first left nothing broken behind it.
    const client = facilitatorClientFor(aPayment({ facilitatorUrl: NOWHERE }));

    await expect(client.verify(aPayload as never, aRequirement as never)).rejects.toThrow();
    await expect(client.settle(aPayload as never, aRequirement as never)).rejects.toThrow();
    await expect(client.verify(aPayload as never, aRequirement as never)).rejects.toThrow();
  });

  it("raises rather than answering when the facilitator fails inside itself", async () => {
    // A 500 is not a verdict about the payment, and the client says so by
    // raising. What the adapter makes of that is its own test; what this one
    // pins is that a broken facilitator never reaches the machine looking like
    // an answer.
    const facilitator = await aFacilitator();
    facilitator.answer("/verify", 500, { error: "internal" });
    facilitator.answer("/settle", 503, { error: "unavailable" });
    const client = facilitatorClientFor(aPayment({ facilitatorUrl: facilitator.url }));

    await expect(client.verify(aPayload as never, aRequirement as never)).rejects.toThrow();
    await expect(client.settle(aPayload as never, aRequirement as never)).rejects.toThrow();
  });

  it("carries a refusal the facilitator sent with a refusing status, and the status with it", async () => {
    // The assumption the whole error taxonomy rests on, checked against the
    // library rather than read off its source: a 4xx whose body is a verdict
    // arrives as a raised error that still carries the verdict and the status.
    // Without both, the adapter above cannot tell a refusal from a silence.
    const facilitator = await aFacilitator();
    facilitator.answer("/verify", 400, {
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_signature",
    });
    const client = facilitatorClientFor(aPayment({ facilitatorUrl: facilitator.url }));

    await expect(client.verify(aPayload as never, aRequirement as never)).rejects.toMatchObject({
      statusCode: 400,
      invalidReason: "invalid_exact_evm_payload_signature",
    });
  });

  it("hands back what the facilitator said when the charge goes through", async () => {
    const facilitator = await aFacilitator();
    facilitator.answer("/settle", 200, {
      success: true,
      transaction: "0xdeadbeef",
      network: "eip155:84532",
    });
    const client = facilitatorClientFor(aPayment({ facilitatorUrl: facilitator.url }));

    const settled = await client.settle(aPayload as never, aRequirement as never);

    expect(settled).toMatchObject({ success: true, transaction: "0xdeadbeef" });
  });
});
