import { describe, expect, it } from "vitest";

import {
  deleteUnattachedPersonRequestSchema,
  deleteUnattachedPersonResponseSchema,
  readSessionRequestSchema,
  readSessionResponseSchema,
  reportIdentityRequestSchema,
  sendReportLinkRequestSchema,
  sendReportLinkResponseSchema,
} from "./report-identity.js";

const scanId = "019b41a0-7c51-7d63-84bd-a5a20faef497";
const requestId = "019b41a0-7c51-7d63-84bd-a5a20faef498";
const operationId = "019b41a0-7c51-7d63-84bd-a5a20faef499";
const timestamp = "2026-09-24T12:00:00.000Z";

const requests = [
  {
    schema: sendReportLinkRequestSchema,
    value: {
      operation: "send",
      email: "owner@example.com",
      destination: { report: scanId },
      request: requestId,
    },
  },
  {
    schema: readSessionRequestSchema,
    value: {
      operation: "session",
      cookie: "agentify.session_token=value.signature",
      renew: true,
    },
  },
  {
    schema: deleteUnattachedPersonRequestSchema,
    value: {
      operation: "delete",
      operation_id: operationId,
      email: "owner@example.com",
    },
  },
] as const;

describe("the internal route between the scanner and the cabinet", () => {
  it("accepts the three questions the scanner asks through the one route", () => {
    for (const { schema, value } of requests) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(reportIdentityRequestSchema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
    }
  });

  it("refuses every request when any required field is absent", () => {
    for (const { schema, value } of requests) {
      for (const field of Object.keys(value)) {
        const incomplete = { ...value } as Record<string, unknown>;
        delete incomplete[field];
        expect(schema.safeParse(incomplete).success, `${value.operation}.${field}`).toBe(false);
      }
    }
  });

  it("names a destination only from the closed set: the report of one scan", () => {
    // Where a link leads is recorded with its token when it is asked for, and
    // nothing in the link is ever read as one (ADR-0026 §1). A destination the
    // set does not hold is refused at the door rather than carried into mail.
    for (const destination of [
      { report: "not-a-scan" },
      { report: scanId, next: "/cabinet/settings" },
      { url: "https://evil.example/" },
      "https://evil.example/",
      "/report/anything",
      {},
    ]) {
      expect(
        sendReportLinkRequestSchema.safeParse({ ...requests[0].value, destination }).success,
        JSON.stringify(destination),
      ).toBe(false);
    }
    expect(
      sendReportLinkRequestSchema.safeParse({ ...requests[0].value, request: "a-request" }).success,
    ).toBe(false);
  });

  it("accepts only scanner-normalized addresses", () => {
    for (const email of [" OWNER@example.com", "OWNER@example.com", "ｏwner@example.com"])
      expect(sendReportLinkRequestSchema.safeParse({ ...requests[0].value, email }).success).toBe(
        false,
      );
  });

  it("carries a cookie header of any ordinary size and no larger", () => {
    expect(
      readSessionRequestSchema.safeParse({ ...requests[1].value, cookie: "a".repeat(8_192) })
        .success,
    ).toBe(true);
    expect(
      readSessionRequestSchema.safeParse({ ...requests[1].value, cookie: "a".repeat(8_193) })
        .success,
    ).toBe(false);
    expect(readSessionRequestSchema.safeParse({ ...requests[1].value, renew: "yes" }).success).toBe(
      false,
    );
  });

  it("answers whose session a cookie is with the address, the operator flag, the waiting request and the renewed cookie", () => {
    const signedIn = {
      status: "signed_in",
      email: "owner@example.com",
      operator: false,
      request: requestId,
      set_cookie: ["agentify.session_token=value.signature; Max-Age=2592000; Path=/"],
    };
    expect(readSessionResponseSchema.safeParse(signedIn).success).toBe(true);
    expect(readSessionResponseSchema.safeParse({ ...signedIn, operator: true }).success).toBe(true);
    // The flag opens the operator's dashboard (ADR-0026 §6), so only a stored
    // yes or no is an answer; anything else is a cabinet the scanner cannot read.
    for (const operator of ["true", 1, null])
      expect(
        readSessionResponseSchema.safeParse({ ...signedIn, operator }).success,
        String(operator),
      ).toBe(false);
    expect(readSessionResponseSchema.safeParse({ ...signedIn, request: null }).success).toBe(true);
    expect(readSessionResponseSchema.safeParse({ ...signedIn, set_cookie: [] }).success).toBe(true);
    expect(readSessionResponseSchema.safeParse({ status: "signed_out" }).success).toBe(true);
    for (const field of Object.keys(signedIn)) {
      const incomplete = { ...signedIn } as Record<string, unknown>;
      delete incomplete[field];
      expect(readSessionResponseSchema.safeParse(incomplete).success, field).toBe(false);
    }
    expect(
      readSessionResponseSchema.safeParse({ status: "signed_out", email: "owner@example.com" })
        .success,
    ).toBe(false);
  });

  it("accepts every closed send and delete result and refuses others", () => {
    for (const value of [
      { status: "accepted" },
      { status: "cooldown", retry_at: timestamp },
      { status: "unavailable" },
    ])
      expect(sendReportLinkResponseSchema.safeParse(value).success).toBe(true);
    expect(sendReportLinkResponseSchema.safeParse({ status: "cooldown" }).success).toBe(false);
    expect(
      sendReportLinkResponseSchema.safeParse({ status: "accepted", token_hash: "h".repeat(43) })
        .success,
    ).toBe(false);

    for (const status of ["deleted", "already_absent", "retained", "refused"])
      expect(deleteUnattachedPersonResponseSchema.safeParse({ status }).success).toBe(true);
    expect(
      deleteUnattachedPersonRequestSchema.safeParse({
        ...requests[2].value,
        operation_id: "550e8400-e29b-41d4-a716-446655440000",
      }).success,
    ).toBe(false);
  });
});
