/**
 * The cabinet's second listener: the internal route the scanner asks over.
 *
 * It publishes no port and is reached by service name on the compose network,
 * behind a secret only the two processes hold (ADR-0024). The scanner asks it
 * three things (ADR-0026 §2): send a link for this address with this
 * destination; whose session is this cookie; and, for a privacy deletion,
 * remove this person if they own no merchant.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import {
  type DeleteUnattachedPersonRequest,
  deleteUnattachedPersonResponseSchema,
  type ReadSessionResponse,
  readSessionResponseSchema,
  reportIdentityRequestSchema,
  type SendReportLinkRequest,
  sendReportLinkResponseSchema,
} from "@agentify/scanner-contracts/report-identity";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Person } from "./cabinet-entry.js";
import { sessionReader } from "./cabinet-key.js";
import type { Identity } from "./identity.js";

export const REPORT_IDENTITY_PATH = "/internal/report-identity";
export const REPORT_IDENTITY_PORT = 3002;

/**
 * The largest body the route reads: a cookie header of the longest length the
 * contract carries, with room for the JSON around it.
 */
const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const HEADERS_TIMEOUT_MS = 5_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

type ReportIdentityOperations = Pick<
  Identity,
  "sendReportLink" | "deleteUnattachedPerson" | "whoIs"
>;

/**
 * The route, with what renews an account's key when a reading of its session
 * was the first of the day (ADR-0014 §2). The scanner's question is a reading
 * like any page's, so a day spent on reports renews the key too.
 */
export function buildReportIdentityApp(
  secret: string,
  identity: ReportIdentityOperations,
  renewKey: (person: Person) => Promise<void>,
) {
  const app = express();
  const readSession = sessionReader(identity, renewKey);

  app.post(
    REPORT_IDENTITY_PATH,
    authorize(secret),
    (request, response, next) => {
      if (!request.is("application/json")) {
        response.status(415).end();
        return;
      }
      next();
    },
    express.json({ limit: MAX_BODY_BYTES, strict: true }),
    async (request, response) => {
      const parsed = reportIdentityRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).end();
        return;
      }
      const operation = parsed.data;
      if (operation.operation === "send") {
        response.json(
          sendReportLinkResponseSchema.parse(
            await identity.sendReportLink(operation as SendReportLinkRequest),
          ),
        );
        return;
      }
      if (operation.operation === "session") {
        const session = await readSession(operation.cookie, { renew: operation.renew });
        const answer: ReadSessionResponse =
          session === null
            ? { status: "signed_out" }
            : {
                status: "signed_in",
                email: session.person.email,
                request: session.request,
                set_cookie: [...session.setCookies],
              };
        response.json(readSessionResponseSchema.parse(answer));
        return;
      }
      response.json(
        deleteUnattachedPersonResponseSchema.parse(
          await identity.deleteUnattachedPerson(operation as DeleteUnattachedPersonRequest),
        ),
      );
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

export function startReportIdentityServer(
  secret: string | null,
  identity: ReportIdentityOperations,
  renewKey: (person: Person) => Promise<void>,
): Server | null {
  if (secret === null) return null;
  const server = buildReportIdentityApp(secret, identity, renewKey).listen(REPORT_IDENTITY_PORT);
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  return server;
}

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
