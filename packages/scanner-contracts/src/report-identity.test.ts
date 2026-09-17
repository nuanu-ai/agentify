import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  acknowledgeReportLinkRequestSchema,
  acknowledgeReportLinkResponseSchema,
  consumeReportLinkRequestSchema,
  consumeReportLinkResponseSchema,
  deleteUnattachedPersonRequestSchema,
  deleteUnattachedPersonResponseSchema,
  issueCabinetLinkRequestSchema,
  issueCabinetLinkResponseSchema,
  reportIdentityRequestSchema,
  reportIdentityTokenHash,
  sendReportLinkRequestSchema,
  sendReportLinkResponseSchema,
} from "./report-identity.js";

const state = "s".repeat(43);
const token = "T".repeat(32);
const tokenHash = createHash("sha256").update(token).digest("base64url");
const receiptId = "550e8400-e29b-41d4-a716-446655440000";
const operationId = "019b41a0-7c51-7d63-84bd-a5a20faef497";
const timestamp = "2026-09-17T12:00:00.000Z";

const requests = [
  {
    schema: sendReportLinkRequestSchema,
    value: {
      operation: "send",
      email: "owner@example.com",
      intent_kind: "registration",
      state,
    },
  },
  {
    schema: consumeReportLinkRequestSchema,
    value: {
      operation: "verify",
      phase: "consume",
      token,
      email: "owner@example.com",
      intent_kind: "recovery",
      state,
    },
  },
  {
    schema: acknowledgeReportLinkRequestSchema,
    value: {
      operation: "verify",
      phase: "acknowledge",
      receipt_id: receiptId,
      token_hash: tokenHash,
    },
  },
  {
    schema: issueCabinetLinkRequestSchema,
    value: { operation: "issue", receipt_id: receiptId, token_hash: tokenHash },
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

describe("private report identity contract", () => {
  it("accepts every closed request variant through the single route union", () => {
    for (const { schema, value } of requests) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(reportIdentityRequestSchema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(
        false,
      );
    }
  });

  it("refuses every request when any required field is absent", () => {
    for (const { schema, value } of requests) {
      for (const field of Object.keys(value)) {
        const incomplete = { ...value } as Record<string, unknown>;
        delete incomplete[field];
        expect(
          schema.safeParse(incomplete).success,
          `${value.operation}.${field}`,
        ).toBe(false);
      }
    }
  });

  it("keeps capabilities and identifiers in their exact formats", () => {
    expect(reportIdentityTokenHash(token)).toBe(tokenHash);
    expect(tokenHash).toHaveLength(43);

    expect(
      consumeReportLinkRequestSchema.safeParse({
        ...requests[1].value,
        token: "-".repeat(32),
      }).success,
    ).toBe(false);
    expect(
      sendReportLinkRequestSchema.safeParse({
        ...requests[0].value,
        state: "s".repeat(42),
      }).success,
    ).toBe(false);
    expect(
      acknowledgeReportLinkRequestSchema.safeParse({
        ...requests[2].value,
        token_hash: createHash("sha256").update(token).digest("hex"),
      }).success,
    ).toBe(false);
    expect(
      deleteUnattachedPersonRequestSchema.safeParse({
        ...requests[4].value,
        operation_id: receiptId,
      }).success,
    ).toBe(false);
  });

  it("accepts only scanner-normalized email claims", () => {
    for (const email of [
      " OWNER@example.com",
      "OWNER@example.com",
      "ｏwner@example.com",
    ])
      expect(
        sendReportLinkRequestSchema.safeParse({ ...requests[0].value, email })
          .success,
      ).toBe(false);
    expect(
      sendReportLinkRequestSchema.safeParse({
        ...requests[0].value,
        email: "owner@example.com",
      }).success,
    ).toBe(true);
  });

  it("accepts every closed phase-specific result and refuses cross-phase states", () => {
    for (const value of [
      { status: "accepted", token_hash: tokenHash },
      { status: "cooldown", retry_at: timestamp },
      { status: "unavailable" },
    ])
      expect(sendReportLinkResponseSchema.safeParse(value).success).toBe(true);

    expect(
      consumeReportLinkResponseSchema.safeParse({
        status: "pending",
        receipt_id: receiptId,
        completion_deadline: timestamp,
      }).success,
    ).toBe(true);
    expect(
      consumeReportLinkResponseSchema.safeParse({ status: "refused" }).success,
    ).toBe(true);
    expect(
      consumeReportLinkResponseSchema.safeParse({ status: "completed" })
        .success,
    ).toBe(false);

    expect(
      acknowledgeReportLinkResponseSchema.safeParse({ status: "completed" })
        .success,
    ).toBe(true);
    expect(
      acknowledgeReportLinkResponseSchema.safeParse({ status: "refused" })
        .success,
    ).toBe(true);
    expect(
      acknowledgeReportLinkResponseSchema.safeParse({ status: "pending" })
        .success,
    ).toBe(false);

    for (const value of [
      {
        status: "issued",
        action_url: "https://agentify.ad/cabinet/sign-in/open?token=secret",
      },
      { status: "already_attempted" },
      { status: "refused" },
    ])
      expect(issueCabinetLinkResponseSchema.safeParse(value).success).toBe(
        true,
      );

    for (const status of ["deleted", "already_absent", "retained", "refused"])
      expect(
        deleteUnattachedPersonResponseSchema.safeParse({ status }).success,
      ).toBe(true);
  });

  it("refuses missing or extra response fields and unsafe action URLs", () => {
    const responses = [
      {
        schema: sendReportLinkResponseSchema,
        value: { status: "accepted", token_hash: tokenHash },
      },
      {
        schema: consumeReportLinkResponseSchema,
        value: {
          status: "pending",
          receipt_id: receiptId,
          completion_deadline: timestamp,
        },
      },
      {
        schema: issueCabinetLinkResponseSchema,
        value: {
          status: "issued",
          action_url: "https://agentify.ad/cabinet/sign-in/open?token=secret",
        },
      },
    ] as const;
    for (const { schema, value } of responses) {
      for (const field of Object.keys(value)) {
        const incomplete = { ...value } as Record<string, unknown>;
        delete incomplete[field];
        expect(
          schema.safeParse(incomplete).success,
          `${value.status}.${field}`,
        ).toBe(false);
      }
      expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(
        false,
      );
    }
    for (const action_url of [
      "file:///tmp/secret",
      "https://user:password@agentify.ad/cabinet/sign-in/open?token=secret",
      "https://agentify.ad/cabinet/sign-in/open?token=secret#leak",
    ])
      expect(
        issueCabinetLinkResponseSchema.safeParse({
          status: "issued",
          action_url,
        }).success,
      ).toBe(false);
  });
});
