import { createHash, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import {
  type AcknowledgeReportLinkRequest,
  acknowledgeReportLinkResponseSchema,
  type ConsumeReportLinkRequest,
  consumeReportLinkResponseSchema,
  type DeleteUnattachedPersonRequest,
  deleteUnattachedPersonResponseSchema,
  type IssueCabinetLinkRequest,
  issueCabinetLinkResponseSchema,
  reportIdentityRequestSchema,
  type SendReportLinkRequest,
  sendReportLinkResponseSchema,
} from "@agentify/scanner-contracts/report-identity";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Identity } from "./identity.js";

export const REPORT_IDENTITY_PATH = "/internal/report-identity";
export const REPORT_IDENTITY_PORT = 3002;

const MAX_BODY_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const HEADERS_TIMEOUT_MS = 5_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

type ReportIdentityOperations = Pick<
  Identity,
  | "sendReportLink"
  | "consumeReportLink"
  | "acknowledgeReportLink"
  | "issueCabinetLink"
  | "deleteUnattachedPerson"
>;

export function buildReportIdentityApp(secret: string, identity: ReportIdentityOperations) {
  const app = express();

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
      if (operation.operation === "verify") {
        response.json(
          operation.phase === "consume"
            ? consumeReportLinkResponseSchema.parse(
                await identity.consumeReportLink(operation as ConsumeReportLinkRequest),
              )
            : acknowledgeReportLinkResponseSchema.parse(
                await identity.acknowledgeReportLink(operation as AcknowledgeReportLinkRequest),
              ),
        );
        return;
      }
      if (operation.operation === "issue") {
        response.json(
          issueCabinetLinkResponseSchema.parse(
            await identity.issueCabinetLink(operation as IssueCabinetLinkRequest),
          ),
        );
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
): Server | null {
  if (secret === null) return null;
  const server = buildReportIdentityApp(secret, identity).listen(REPORT_IDENTITY_PORT);
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
