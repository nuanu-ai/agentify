/**
 * The optional card signal and Stripe's webhook, asked of the whole process
 * over HTTP. The card signal's routes answer only a signed-in visitor who owns
 * the report, which the dashboard and the database decide; their refusals
 * before that are here. The webhook is held to the body Stripe signed, byte
 * for byte: the database it is pointed at is a listener that counts the
 * connections made to it and answers none, so an event whose signature held
 * is one that reached for it.
 */

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowedAt,
  fromSite,
  refusalOf,
  SIGNED_IN,
  stubOfflineScanner,
} from "../../../../testing/api";
import { ask } from "../../../../testing/scanner";

let database: Server;
let connections = 0;

beforeAll(async () => {
  database = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => database.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise((resolve) => database.close(resolve));
});

/** Put together when the tests run, so no secret-looking value is written here. */
const WEBHOOK_SECRET = ["a", "webhook", "secret", "for", "tests"].join("-");

beforeEach(() => {
  stubOfflineScanner();
  const { port } = database.address() as { port: number };
  vi.stubEnv("DATABASE_URL", `postgresql://nobody:unused@127.0.0.1:${port}/nowhere`);
  vi.stubEnv("STRIPE_ADAPTER", "local");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  connections = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const SCAN = "0190f4c5-0000-7000-8000-000000000000";
const SIGNAL = "0190f4c5-1111-7000-8000-000000000000";

describe("setting up a card signal", () => {
  const consented = { scan_id: SCAN, card_signal_consent: true };
  const setUp = (body: unknown, headers: Record<string, string> = {}) =>
    fromSite("/api/v1/card-signals/setup-intents", "POST", body, {
      "idempotency-key": "card-key-0001",
      ...headers,
    });

  it("refuses a setup asked from another origin", async () => {
    const answered = await setUp(consented, { origin: "https://elsewhere.example" });

    expect(answered.status).toBe(403);
    expect((await refusalOf(answered)).code).toBe("invalid_origin");
  });

  it.each([
    ["without an idempotency key", { "idempotency-key": "" }],
    ["with a key shorter than eight characters", { "idempotency-key": "short" }],
  ])("refuses a setup asked %s", async (_how, headers) => {
    const answered = await setUp(consented, headers);

    expect(answered.status).toBe(400);
    expect((await refusalOf(answered)).code).toBe("invalid_idempotency_key");
  });

  it.each([
    ["names no consent", { scan_id: SCAN }],
    ["declines the consent", { scan_id: SCAN, card_signal_consent: false }],
    ["names no scan", { card_signal_consent: true }],
    ["names a scan by something other than its id", { ...consented, scan_id: "scan-1" }],
  ])("refuses a setup whose request %s", async (_why, body) => {
    const answered = await setUp(body);

    expect(answered.status).toBe(400);
    expect((await refusalOf(answered)).code).toBe("invalid_card_signal_request");
  });

  it("says the signal is off while it is not enabled", async () => {
    const answered = await setUp(consented);

    expect(answered.status).toBe(503);
    expect((await refusalOf(answered)).code).toBe("card_signal_disabled");
  });

  it("does not say a report exists to a visitor who is not signed in", async () => {
    vi.stubEnv("CARD_SIGNAL_ENABLED", "true");

    const answered = await setUp(consented);

    expect(answered.status).toBe(404);
    expect((await refusalOf(answered)).code).toBe("report_not_found");
  });

  it("takes a post alone, and is no signal named after it", async () => {
    expect((await ask("/api/v1/card-signals/setup-intents")).status).toBe(405);
    expect(await allowedAt("/api/v1/card-signals/setup-intents")).toBe("OPTIONS, POST");
  });
});

describe("a card signal", () => {
  const ROUTES = [
    ["its state", `/api/v1/card-signals/${SIGNAL}`, "GET"],
    ["its local confirmation", `/api/v1/card-signals/${SIGNAL}/local-confirm`, "POST"],
    ["its payment method's removal", `/api/v1/card-signals/${SIGNAL}/payment-method`, "DELETE"],
  ] as const;

  it.each(ROUTES)(
    "is not there for a visitor who is not signed in: %s",
    async (_what, path, method) => {
      const answered = await fromSite(path, method);

      expect(answered.status).toBe(404);
      expect((await refusalOf(answered)).code).toBe("card_signal_not_found");
    },
  );

  it.each(ROUTES)(
    "says it cannot tell who is visiting where the dashboard does not answer: %s",
    async (_what, path, method) => {
      const answered = await fromSite(path, method, undefined, { cookie: SIGNED_IN });

      expect(answered.status).toBe(503);
      expect((await refusalOf(answered)).code).toBe("visitor_unknown");
    },
  );

  it.each(ROUTES.slice(1))(
    "refuses a change asked from another origin: %s",
    async (_what, path, method) => {
      const answered = await fromSite(path, method, undefined, {
        origin: "https://elsewhere.example",
      });

      expect(answered.status).toBe(403);
      expect((await refusalOf(answered)).code).toBe("invalid_origin");
    },
  );

  it.each([
    [`/api/v1/card-signals/${SIGNAL}`, "GET, HEAD, OPTIONS"],
    [`/api/v1/card-signals/${SIGNAL}/local-confirm`, "OPTIONS, POST"],
    [`/api/v1/card-signals/${SIGNAL}/payment-method`, "DELETE, OPTIONS"],
  ])("takes the methods it names: %s", async (path, allow) => {
    expect(await allowedAt(path)).toBe(allow);
    expect((await fromSite(path, "PUT", {})).status).toBe(405);
  });
});

/** Stripe's signature header: a timestamp, and an HMAC of it and the body's bytes. */
const stripeSignature = (body: string, at = Math.floor(Date.now() / 1000)): string =>
  `t=${at},v1=${createHmac("sha256", WEBHOOK_SECRET).update(`${at}.${body}`).digest("hex")}`;

/** An event as Stripe sends it, with spacing, an accent and a line ending a parser would not keep. */
const EVENT =
  '{"id": "evt_bytes_as_sent",  "type": "customer.created",\n  "data": {"object": {"name": "Zoë"}}}\r\n';

const deliver = (body: string, headers: Record<string, string>) =>
  ask("/api/v1/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body,
  });

describe("Stripe's webhook", () => {
  it("takes an event signed over the bytes sent on to its records, from Stripe, which names no origin", async () => {
    await deliver(EVENT, { "stripe-signature": stripeSignature(EVENT) });

    expect(connections).toBe(1);
  });

  it("rejects an event whose bytes are not the ones signed, and reads no record for it", async () => {
    const reparsed = JSON.stringify(JSON.parse(EVENT));

    const answered = await deliver(reparsed, { "stripe-signature": stripeSignature(EVENT) });

    expect(answered.status).toBe(400);
    expect(await refusalOf(answered)).toMatchObject({
      code: "stripe_webhook_rejected",
      retryable: true,
    });
    expect(connections).toBe(0);
  });

  it("refuses an event that carries no signature", async () => {
    const answered = await deliver(EVENT, {});

    expect(answered.status).toBe(400);
    expect((await refusalOf(answered)).code).toBe("stripe_signature_missing");
    expect(connections).toBe(0);
  });

  it("takes a post alone", async () => {
    expect((await ask("/api/v1/webhooks/stripe")).status).toBe(405);
    expect(await allowedAt("/api/v1/webhooks/stripe")).toBe("OPTIONS, POST");
  });
});
