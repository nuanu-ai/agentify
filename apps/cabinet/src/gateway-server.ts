/**
 * The cabinet's second internal listener: the gateway's route, where the
 * gateway asks it to tell a merchant of a change to their payout wallet or
 * their keys (ADR-0019). Each request names its `operation`; announcing is the
 * only one, and anything else the gateway ever asks the cabinet is another
 * operation here, behind the same secret.
 *
 * It is its own listener, on its own port and behind its own secret, rather
 * than another operation on the scanner's report identity route. The two
 * callers are different processes with different powers: the scanner may ask
 * the cabinet to send a sign-in link, name a session and remove a person, and
 * the gateway may ask it to send a message and nothing else. One route with
 * one secret would hand each of them the other's door, and the money path the
 * power to look up sessions and remove people.
 *
 * Nothing publishes the port; it answers on the compose network alone. It
 * authenticates before it reads anything, reads one announcement against the
 * gateway's own wire, tells every account that names the merchant, and answers
 * with what became of the messages. The gateway records a wallet change only
 * on `handed_over`, so the answer is what decides whether a change waits — and
 * a failure in here is a 503 with no body, which the gateway reads as no
 * answer and refuses the change as one whose message may have gone out.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import {
  type Announcement,
  type AnnouncementAnswer,
  GATEWAY_ROUTE_PATH,
  GATEWAY_ROUTE_PORT,
  GatewayRequestSchema,
} from "@agentify/gateway/announcements";
import express, { type NextFunction, type Request, type Response } from "express";
import { announcementMessage } from "./announcement-mail.js";
import type { CabinetConfig } from "./config.js";
import type { Identity } from "./identity.js";
import type { Postman } from "./mail.js";

const MAX_BODY_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 5_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

/** Tells every account naming a merchant, and says what became of the messages. */
export type Teller = (announcement: Announcement) => Promise<AnnouncementAnswer["outcome"]>;

/**
 * The teller this cabinet runs: the accounts naming the merchant, a message
 * each, handed to the mail provider one after another.
 *
 * Every account is sent a message even after one is refused, because the
 * answer is not the only thing that matters — a person who was told has been
 * told — and the answer is then `not_handed_over`, which the gateway turns into
 * a refusal that says a message may still have reached somebody.
 */
export function tellerFor(
  config: CabinetConfig,
  identity: Pick<Identity, "emailsNaming">,
  postman: Postman,
): Teller {
  const base = `${config.publicBaseUrl}${config.basePath}`;
  const screens = { wallet: `${base}/settings`, keys: `${base}/keys` };
  return async (announcement) => {
    const addresses = await identity.emailsNaming(announcement.merchant_id);
    if (addresses.length === 0) {
      console.log(`[cabinet] ${announcement.kind}: no account names the merchant, nobody told`);
      return "nobody_to_tell";
    }
    let refused = 0;
    for (const address of addresses) {
      if ((await postman(announcementMessage(address, announcement, screens))) !== "accepted") {
        refused += 1;
      }
    }
    // Counts and nothing else: the addresses stay out of a process log.
    console.log(
      `[cabinet] ${announcement.kind}: ${addresses.length - refused} of ${addresses.length} messages handed over`,
    );
    return refused === 0 ? "handed_over" : "not_handed_over";
  };
}

export function buildGatewayApp(secret: string, tell: Teller) {
  const app = express();

  app.post(
    GATEWAY_ROUTE_PATH,
    authorize(secret),
    express.json({ limit: MAX_BODY_BYTES, strict: true }),
    async (request, response) => {
      const read = GatewayRequestSchema.safeParse(request.body);
      if (!read.success) {
        response.status(400).end();
        return;
      }
      const answer: AnnouncementAnswer = { outcome: await tell(read.data) };
      response.json(answer);
    },
  );

  app.use((_request, response) => {
    response.status(404).end();
  });
  app.use((thrown: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = errorStatus(thrown);
    response.status(status === 400 || status === 413 ? status : 503).end();
  });
  return app;
}

/** Opens the listener where this cabinet holds the secret, and nowhere else. */
export function startGatewayServer(secret: string | null, tell: Teller): Server | null {
  if (secret === null) return null;
  const server = buildGatewayApp(secret, tell).listen(GATEWAY_ROUTE_PORT);
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  return server;
}

/**
 * The secret, compared over digests so the comparison takes the same time
 * whatever was presented, and before a byte of the body is read.
 */
function authorize(secret: string) {
  const expected = digest(`Bearer ${secret}`);
  return (request: Request, response: Response, next: NextFunction): void => {
    const supplied = request.get("authorization");
    if (supplied === undefined || !timingSafeEqual(digest(supplied), expected)) {
      response.status(401).end();
      return;
    }
    next();
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function errorStatus(thrown: unknown): number | null {
  if (typeof thrown !== "object" || thrown === null || !("status" in thrown)) return null;
  const status = (thrown as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}
