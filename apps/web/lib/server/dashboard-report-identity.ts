import {
  type DeleteUnattachedPersonResponse,
  deleteUnattachedPersonResponseSchema,
  type ReadSessionResponse,
  readSessionResponseSchema,
  type SendDataCopyResponse,
  type SendReportLinkResponse,
  sendDataCopyResponseSchema,
  sendReportLinkResponseSchema,
} from "@agentify/scanner-contracts/report-identity";
import type { z } from "zod";

import { getServerConfig } from "./config";

const REPORT_IDENTITY_PATH = "/internal/report-identity";
/** A link and a deletion are worth waiting for; no page is waiting on them. */
const REPORT_IDENTITY_TIMEOUT_MS = 15_000;
/**
 * Every scanner page that shows who is visiting waits on this question, so a
 * hanging dashboard must turn into "we cannot tell who is visiting" in seconds.
 */
const SESSION_QUESTION_TIMEOUT_MS = 3_000;
/**
 * A copy is read from the dashboard's tables and handed to the mail provider,
 * whose own deadline is ten seconds, while the person who pressed waits.
 */
const DATA_COPY_TIMEOUT_MS = 30_000;

class DashboardIdentityUnavailableError extends Error {
  constructor() {
    super("dashboard_identity_unavailable");
    this.name = "DashboardIdentityUnavailableError";
  }
}

type Fetch = typeof fetch;

type ClientOptions = Readonly<{
  baseUrl: string;
  secret: string;
  fetchImpl?: Fetch;
}>;

/** The scanner never handles a sign-in token and mints no session; it asks the dashboard. */
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
  /** For an access request: mail this address a copy of its data, with the scanner's part. */
  sendDataCopy(input: {
    request: string;
    email: string;
    scanner: Record<string, unknown>;
  }): Promise<SendDataCopyResponse>;
}>;

export function createDashboardReportIdentityClient(options: ClientOptions): Client {
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
        throw new DashboardIdentityUnavailableError();
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new DashboardIdentityUnavailableError();
      return parsed.data;
    } catch (error) {
      if (error instanceof DashboardIdentityUnavailableError) throw error;
      throw new DashboardIdentityUnavailableError();
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
    sendDataCopy: ({ request, email, scanner }) =>
      post(
        { operation: "copy", request, email, scanner },
        sendDataCopyResponseSchema,
        DATA_COPY_TIMEOUT_MS,
      ),
  };
}

export function getDashboardReportIdentityClient(): Client {
  const config = getServerConfig();
  if (!config.DASHBOARD_IDENTITY_URL || !config.REPORT_IDENTITY_SECRET) {
    throw new DashboardIdentityUnavailableError();
  }
  return createDashboardReportIdentityClient({
    baseUrl: config.DASHBOARD_IDENTITY_URL,
    secret: config.REPORT_IDENTITY_SECRET,
  });
}
