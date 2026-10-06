import {
  type DeleteUnattachedPersonResponse,
  deleteUnattachedPersonResponseSchema,
  type ReadSessionResponse,
  readSessionResponseSchema,
  type SendReportLinkResponse,
  sendReportLinkResponseSchema,
} from "@agentify/scanner-contracts/report-identity";
import type { z } from "zod";

import { getServerConfig } from "./config";

const REPORT_IDENTITY_PATH = "/internal/report-identity";
/** A link and a deletion are worth waiting for; nobody is looking at a page. */
const REPORT_IDENTITY_TIMEOUT_MS = 15_000;
/**
 * Whose session a cookie is, asked while a page waits on the answer.
 *
 * Every scanner page that shows who is visiting asks this, so a cabinet that
 * hangs has to become "we cannot tell who is visiting" in seconds rather than
 * a page that never draws (ADR-0026 §2).
 */
const SESSION_QUESTION_TIMEOUT_MS = 3_000;

export class CabinetIdentityUnavailableError extends Error {
  constructor() {
    super("cabinet_identity_unavailable");
    this.name = "CabinetIdentityUnavailableError";
  }
}

type Fetch = typeof fetch;

type ClientOptions = Readonly<{
  baseUrl: string;
  secret: string;
  fetchImpl?: Fetch;
}>;

/**
 * The three things the scanner asks the cabinet over the internal route
 * (ADR-0026 §2). The scanner never handles a token and mints no session.
 */
type Client = Readonly<{
  /** Send a link for this address, leading to this scan's report, for this request. */
  sendReportLink(input: {
    email: string;
    scanId: string;
    request: string;
  }): Promise<SendReportLinkResponse>;
  /** Whose session this cookie header is; `renew` only where the answer can pass a cookie on. */
  readSession(input: { cookie: string; renew: boolean }): Promise<ReadSessionResponse>;
  /** For a privacy deletion: remove this person if they own no merchant. */
  deleteUnattachedPerson(input: {
    operationId: string;
    email: string;
  }): Promise<DeleteUnattachedPersonResponse>;
}>;

export function createCabinetReportIdentityClient(options: ClientOptions): Client {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = new URL(REPORT_IDENTITY_PATH, options.baseUrl);

  async function post<T>(
    body: object,
    responseSchema: z.ZodType<T>,
    timeoutMs = REPORT_IDENTITY_TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (
        response.status !== 200 ||
        !response.headers.get("content-type")?.startsWith("application/json")
      ) {
        throw new CabinetIdentityUnavailableError();
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new CabinetIdentityUnavailableError();
      return parsed.data;
    } catch (error) {
      if (error instanceof CabinetIdentityUnavailableError) throw error;
      throw new CabinetIdentityUnavailableError();
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    sendReportLink: ({ email, scanId, request }) =>
      post(
        { operation: "send", email, destination: { report: scanId }, request },
        sendReportLinkResponseSchema,
      ),
    readSession: ({ cookie, renew }) =>
      post(
        { operation: "session", cookie, renew },
        readSessionResponseSchema,
        SESSION_QUESTION_TIMEOUT_MS,
      ),
    deleteUnattachedPerson: ({ operationId, email }) =>
      post(
        { operation: "delete", operation_id: operationId, email },
        deleteUnattachedPersonResponseSchema,
      ),
  };
}

export function getCabinetReportIdentityClient(): Client {
  const config = getServerConfig();
  if (!config.CABINET_IDENTITY_URL || !config.REPORT_IDENTITY_SECRET) {
    throw new CabinetIdentityUnavailableError();
  }
  return createCabinetReportIdentityClient({
    baseUrl: config.CABINET_IDENTITY_URL,
    secret: config.REPORT_IDENTITY_SECRET,
  });
}
