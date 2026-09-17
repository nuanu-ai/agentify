import {
  acknowledgeReportLinkResponseSchema,
  consumeReportLinkResponseSchema,
  deleteUnattachedPersonResponseSchema,
  issueCabinetLinkResponseSchema,
  sendReportLinkResponseSchema,
  type AcknowledgeReportLinkResponse,
  type ConsumeReportLinkResponse,
  type DeleteUnattachedPersonResponse,
  type IssueCabinetLinkResponse,
  type SendReportLinkResponse,
} from "@agentify/scanner-contracts/report-identity";
import type { z } from "zod";

import { getServerConfig } from "./config";

const REPORT_IDENTITY_PATH = "/internal/report-identity";
const REPORT_IDENTITY_TIMEOUT_MS = 15_000;

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

type Client = Readonly<{
  sendReportLink(input: {
    email: string;
    intentKind: "registration" | "recovery";
    state: string;
  }): Promise<SendReportLinkResponse>;
  consumeReportLink(input: {
    token: string;
    email: string;
    intentKind: "registration" | "recovery";
    state: string;
  }): Promise<ConsumeReportLinkResponse>;
  acknowledgeReportLink(input: {
    receiptId: string;
    tokenHash: string;
  }): Promise<AcknowledgeReportLinkResponse>;
  issueCabinetLink(input: {
    receiptId: string;
    tokenHash: string;
  }): Promise<IssueCabinetLinkResponse>;
  deleteUnattachedPerson(input: {
    operationId: string;
    email: string;
  }): Promise<DeleteUnattachedPersonResponse>;
}>;

export function createCabinetReportIdentityClient(
  options: ClientOptions,
): Client {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = new URL(REPORT_IDENTITY_PATH, options.baseUrl);

  async function post<T>(
    body: object,
    responseSchema: z.ZodType<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REPORT_IDENTITY_TIMEOUT_MS,
    );
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
    sendReportLink: ({ email, intentKind, state }) =>
      post(
        {
          operation: "send",
          email,
          intent_kind: intentKind,
          state,
        },
        sendReportLinkResponseSchema,
      ),
    consumeReportLink: ({ token, email, intentKind, state }) =>
      post(
        {
          operation: "verify",
          phase: "consume",
          token,
          email,
          intent_kind: intentKind,
          state,
        },
        consumeReportLinkResponseSchema,
      ),
    acknowledgeReportLink: ({ receiptId, tokenHash }) =>
      post(
        {
          operation: "verify",
          phase: "acknowledge",
          receipt_id: receiptId,
          token_hash: tokenHash,
        },
        acknowledgeReportLinkResponseSchema,
      ),
    issueCabinetLink: ({ receiptId, tokenHash }) =>
      post(
        {
          operation: "issue",
          receipt_id: receiptId,
          token_hash: tokenHash,
        },
        issueCabinetLinkResponseSchema,
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
