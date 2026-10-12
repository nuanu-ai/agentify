/**
 * A whole gateway with the real flows and order machine, in-memory adapters in
 * place of the database, the queue server and the payment network, and a
 * worker that behaves the way a merchant's does.
 */

import type { AddressInfo } from "node:net";
import { type Environment, keyPrefixFor } from "@agentify/core";
import type {
  HandlerAnswer,
  Order,
  QuoteResponse,
  WorkerPollResponse,
} from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { RecordingAnnouncer } from "../adapters/memory/announcer.js";
import { ScriptedFacilitator } from "../adapters/memory/facilitator.js";
import { MemoryQueue } from "../adapters/memory/queue.js";
import { MemoryStore } from "../adapters/memory/store.js";
import { Gateway } from "../app/gateway.js";
import {
  grantLiveApproval,
  issueKey,
  keyDigest,
  setPayoutWallet,
  setServiceName,
} from "../app/merchants.js";
import type { Runtime } from "../app/runtime.js";
import { type GatewayConfig, loadConfig } from "../config.js";
import { buildApp } from "../http/server.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  PaymentEdge,
  paymentFingerprint,
  X402_VERSION,
} from "../http/x402.js";
import type { Ids } from "../ports/clock.js";
import type { Integration } from "../ports/store.js";

/** Identifiers a test can read: ord_1, item_1, env_3. */
export const countedIds = (): Ids => {
  const issued = new Map<string, number>();
  return (kind) => {
    const next = (issued.get(kind) ?? 0) + 1;
    issued.set(kind, next);
    return `${kind}_${next}`;
  };
};

export const testConfig = (overrides: Record<string, string> = {}): GatewayConfig =>
  loadConfig({
    DATABASE_URL: "postgres://agentify@localhost:5432/agentify",
    ...overrides,
  });

/** A merchant the harness made, with one key of theirs, readable once here. */
export interface SeededMerchant {
  readonly id: string;
  readonly name: string;
  /** The secret itself. Only a test ever holds one of these. */
  readonly key: string;
  /** The row the key is, so a test can disable it. */
  readonly keyId: string;
  /**
   * The address this merchant is paid at, unique among seeded merchants.
   * Compare against this rather than writing the address out, which would pin
   * the harness's counter.
   */
  readonly wallet: string;
}

export interface Harness {
  readonly gateway: Gateway;
  readonly runtime: Runtime;
  readonly store: MemoryStore;
  readonly queue: MemoryQueue;
  readonly facilitator: ScriptedFacilitator;
  /**
   * What the gateway asked the dashboard to tell a merchant, and what the dashboard
   * answers. A harness never calls a dashboard, whatever its configuration names.
   */
  readonly announcer: RecordingAnnouncer;
  readonly now: () => number;
  /** Moves the clock the flows read. Nothing fires from this on its own. */
  readonly advance: (ms: number) => void;
  /**
   * A merchant with one key, made the way the command-line verb makes one. A
   * test about scoping needs two: an unscoped gateway passes everything a single
   * merchant can assert about their own cards.
   */
  readonly addMerchant: (name?: string) => Promise<SeededMerchant>;
  /** A second key for a merchant who already has one. The secret, once. */
  readonly addKey: (merchantId: string, label?: string) => Promise<string>;
  /** Stops one key working, touching no other. */
  readonly disableKey: (keyId: string) => Promise<void>;
  /**
   * The merchant a test gets without asking, for tests that need a seller but
   * are not about one. Tests about tenancy seed two of their own.
   */
  readonly merchant: SeededMerchant;
  stop(): Promise<void>;
}

/**
 * The harness merchant's key for an environment. Pass the harness's own: the
 * door checks the key's prefix first, so a harness given a `PAYMENT_NETWORK`
 * override answers 401 to a key made for another environment.
 */
export const theMerchantKey = (environment: Environment): string =>
  `${keyPrefixFor(environment)}a-merchant-key-long-enough`;

export async function harness(overrides: Record<string, string> = {}): Promise<Harness> {
  // Moves only on `advance`, so deadlines are arithmetic to check by eye. The
  // store stamps payment claims from it too, so `advance` moves those as well.
  let now = Date.parse("2026-08-26T12:00:00.000Z");

  const config = testConfig(overrides);
  // From the configuration, so a test that overrides these numbers gets them.
  const queue = new MemoryQueue({
    attempts: config.reminderAttempts,
    retryDelayMs: config.reminderRetryDelayMs,
  });
  // The store writes an order's envelopes through the queue in the same step as
  // the order, and a test that replaces `queue.stage` replaces the store's too.
  const store = new MemoryStore(countedIds(), () => now, queue.envelopes());
  const facilitator = new ScriptedFacilitator();
  const announcer = new RecordingAnnouncer();
  const ids = countedIds();

  const runtime: Runtime = {
    config,
    store,
    queue,
    facilitator,
    clock: () => now,
    ids,
    announcer,
  };

  const gateway = new Gateway(runtime);
  await gateway.start();

  // Seeded through the functions the command-line verbs and the sandbox seed
  // use, so a key's digest is computed one way everywhere. A merchant without a
  // listing name or a wallet publishes nothing, so both are set; the name passes
  // the catalogue's check (at most 32 printable ASCII characters) or the harness
  // throws here.
  const seed = async (name: string, secret?: string): Promise<SeededMerchant> => {
    const made = await store.addMerchant({ id: ids("mch"), name }, now);
    if (made === null) {
      throw new Error(`the harness could not make the merchant ${name}`);
    }
    await setServiceName(store, made.id, name, now);
    // One wallet per merchant, or a gateway paying every sale to one address
    // would pass a test about whose it is.
    const wallet = aSeededWallet();
    await setPayoutWallet(store, made.id, wallet, now);
    // A live gateway sells only for approved merchants. Approval is granted
    // here rather than defaulted, so merchants made any other way stay
    // unapproved.
    if (config.surfaceMode === "live") {
      await grantLiveApproval(store, made.id, now);
    }
    const issued =
      secret === undefined
        ? await issueKey(store, ids, made.id, "the harness", now, config.environment)
        : await addKnownKey(store, ids, made.id, secret, now);
    return { id: made.id, name: made.name, key: issued.secret, keyId: issued.key.id, wallet };
  };

  // A throw after the gateway starts would never reach the caller's `stop()`,
  // leaving its queue timers and parked polls running to the end of the suite.
  try {
    const merchant = await seed("The merchant", theMerchantKey(config.environment));

    return {
      gateway,
      runtime,
      store,
      queue,
      facilitator,
      announcer,
      merchant,
      now: () => now,
      advance: (ms) => {
        now += ms;
      },
      addMerchant: (name = `Merchant ${countedName()}`) => seed(name),
      addKey: async (merchantId, label = "another of the harness's") =>
        (await issueKey(store, ids, merchantId, label, now, config.environment)).secret,
      disableKey: async (keyId) => {
        const disabled = await store.disableKey(keyId, now);
        if (disabled === null) {
          throw new Error(`the harness was asked to disable ${keyId}, and there is no such key`);
        }
      },
      stop: () => gateway.stop(),
    };
  } catch (thrown) {
    await gateway.stop();
    throw thrown;
  }
}

/**
 * A key with a secret the caller chose, which `issueKey` will not do because a
 * chosen key is a reused key. Only the harness's own merchant has one, so a
 * test can write its key into a header by hand.
 */
async function addKnownKey(
  store: MemoryStore,
  ids: Ids,
  merchantId: string,
  secret: string,
  at: number,
): Promise<{ key: { id: string }; secret: string }> {
  const key = await store.addKey(
    {
      id: ids("mk"),
      merchantId,
      label: "the harness's known key",
      digest: keyDigest(secret),
    },
    at,
  );
  return { key, secret };
}

/**
 * An address no other seeded merchant has, counted upwards so two side by side
 * in a failure are told apart. All digits, so it is its own checksummed form
 * and says nothing about checksums; tests about the canonical form use
 * addresses with letters.
 */
const aSeededWallet = (() => {
  let issued = 0;
  return () => {
    issued += 1;
    return `0x${issued.toString().padStart(40, "0")}`;
  };
})();

/** A, B, C… so two merchants in one test are told apart at a glance. */
const countedName = (() => {
  let issued = 0;
  return () => {
    issued += 1;
    return String.fromCharCode(65 + ((issued - 1) % 26));
  };
})();

/** What a merchant's handler does with one order. */
export type OrderHandler = (order: Order) => HandlerAnswer | Promise<HandlerAnswer>;
/** What a merchant's pricing does with one question. */
export type PriceHandler = (question: {
  readonly merchant_item_id: string;
  readonly price_id: string;
}) => QuoteResponse | Promise<QuoteResponse>;

export interface WorkerBehaviour {
  readonly onOrder?: OrderHandler;
  readonly onQuote?: PriceHandler;
  /** Whose worker this is; the harness's own merchant when left out. */
  readonly merchantId?: string;
  /**
   * Which integration's worker this is: the merchant's own code when left out,
   * or the dashboard's connector for a shop. A worker of the one its merchant
   * is not selling through draws nothing.
   */
  readonly through?: Integration;
}

/** A gateway to work against, and the merchant a worker belongs to by default. */
export type Worked = Harness | { readonly gateway: Gateway; readonly merchant: SeededMerchant };

/**
 * One turn of a merchant's worker: poll that merchant's stream once and post
 * each handler's return value to the answer route, in every mode, as the SDK's
 * loop does. Returns how many envelopes came.
 */
export async function workOnce(
  worked: Worked,
  behaviour: WorkerBehaviour,
  waitMs = 1_000,
): Promise<number> {
  const { gateway } = worked;
  const merchantId = behaviour.merchantId ?? worked.merchant.id;
  const { envelopes } = await gateway.poll(merchantId, waitMs, {
    through: behaviour.through ?? "api",
  });

  for (const envelope of envelopes) {
    if (envelope.kind === "order" && behaviour.onOrder !== undefined) {
      const answer = await behaviour.onOrder(envelope.payload);
      await gateway.answerOrder(merchantId, envelope.payload.id, answer);
    }
    if (envelope.kind === "quote_request" && behaviour.onQuote !== undefined) {
      const answer = await behaviour.onQuote(envelope.payload);
      await gateway.answerQuote(merchantId, envelope.payload.price_id, answer);
    }
  }

  return envelopes.length;
}

/**
 * Everything on a merchant's stream now, polled until a poll comes back empty.
 * A poll answers with one envelope, so one poll is not the whole stream.
 */
export async function drawEverything(
  worked: Worked,
  merchantId: string = worked.merchant.id,
): Promise<WorkerPollResponse["envelopes"]> {
  const drawn: WorkerPollResponse["envelopes"][number][] = [];
  for (;;) {
    const { envelopes } = await worked.gateway.poll(merchantId, 0);
    if (envelopes.length === 0) return drawn;
    drawn.push(...envelopes);
  }
}

/** Keeps a worker turning until `stop` is called, the way a subscription does. */
export function workUntilStopped(worked: Worked, behaviour: WorkerBehaviour) {
  let running = true;
  const loop = (async () => {
    while (running) {
      await workOnce(worked, behaviour, 50);
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}

/**
 * One purchase over HTTP as an agent's client makes it: ask the price, sign
 * against the challenge, present it, with a worker answering alongside. The
 * worker starts before the first call, because that is when a card with a price
 * check asks its merchant; started later, the purchase would wait out the
 * gateway's whole patience.
 */
export async function buyOverHttp(
  worked: Worked,
  served: Served,
  itemId: string,
  behaviour: WorkerBehaviour,
  /** What the agent sends to ask the price, and then again with its payment. */
  body: { readonly priced: unknown; readonly paid: unknown } = {
    priced: { params: {} },
    paid: { params: {} },
  },
): Promise<Call> {
  const worker = workUntilStopped(worked, behaviour);
  try {
    const priced = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: body.priced,
    });
    const requirements = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    ).accepts[0];
    if (requirements === undefined) {
      throw new Error(`no payment option was offered for ${itemId}`);
    }

    return await served.call("POST", `/x402/${itemId}/purchase`, {
      body: body.paid,
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: aFreshSignature() },
        }),
      },
    });
  } finally {
    await worker.stop();
  }
}

/**
 * A signature no other purchase has presented. The first order to present a
 * payment claims it, so a shared constant would get a second sale refused as a
 * replay.
 */
const aFreshSignature = (() => {
  let signed = 0;
  return () => {
    signed += 1;
    return `0xsigned${signed}`;
  };
})();

/**
 * One wallet's authorisation as a real x402 header, with the fingerprint the
 * purchase route takes of it. The signer sits where the exact-EVM scheme puts
 * it, and two nonces from one wallet give two fingerprints and one payer. Only
 * the envelope is real: a real deployment would refuse the contents, so it
 * answers only who signed, not whether a payment is valid.
 */
export function authorisation(
  worked: { readonly runtime: Runtime },
  wallet: string,
  nonce: string,
): { readonly payment: string; readonly fingerprint: string } {
  return encoded(worked, {
    signature: aFreshSignature(),
    authorization: { from: wallet, to: NOWHERE, nonce },
  });
}

/**
 * A well-formed payment that names no payer: a signature with no authorisation,
 * as {@link buyOverHttp} and any scheme without an EIP-3009 authorisation send.
 * Only its fingerprint tells two such buyers apart.
 */
export function paymentNamingNoPayer(worked: { readonly runtime: Runtime }): {
  readonly payment: string;
  readonly fingerprint: string;
} {
  return encoded(worked, { signature: aFreshSignature() });
}

function encoded(
  worked: { readonly runtime: Runtime },
  payload: Record<string, unknown>,
): { readonly payment: string; readonly fingerprint: string } {
  const { config } = worked.runtime;
  const edge = new PaymentEdge(config.payment, config.publicBaseUrl, config.payment.timeoutSeconds);
  const signed: PaymentPayload = {
    x402Version: X402_VERSION,
    // Nothing checks this offer against a merchant, and the fingerprint ignores
    // the address.
    accepted: edge.requirementsFor({ amount: "0.00", currency: "USD" }, null, NOWHERE),
    payload,
  };

  return {
    payment: encodePaymentSignatureHeader(signed),
    fingerprint: paymentFingerprint(signed, edge.token()),
  };
}

/** The zero address: an offer made out to nobody, in a payment nobody checks. */
const NOWHERE = "0x0000000000000000000000000000000000000000";

/** One call against a gateway actually listening on a port. */
export interface Call {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface Served {
  readonly url: string;
  call(
    method: string,
    path: string,
    options?: { readonly body?: unknown; readonly headers?: Record<string, string> },
  ): Promise<Call>;
  close(): Promise<void>;
}

/**
 * Puts the whole surface on a real port on 127.0.0.1 and calls it over real
 * HTTP. The host must stay named: `listen(0)` alone binds `[::]` and leaves the
 * same port free on 127.0.0.1, where another suite's server can take it and
 * receive these calls (seen as `SocketError: other side closed`).
 */
export async function serve(harnessed: { readonly gateway: Gateway }): Promise<Served> {
  const app = buildApp(harnessed.gateway);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    async call(method, path, options = {}) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        // Left as text: a test asserting on a non-JSON answer wants to see it.
      }
      return { status: response.status, headers: response.headers, body };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
