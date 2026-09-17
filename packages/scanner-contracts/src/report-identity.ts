import { createHash } from "node:crypto";
import { z } from "zod";

const base64urlCapabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const rawIdentityTokenSchema = z.string().regex(/^[A-Za-z0-9]{32}$/);
const receiptIdSchema = z.uuid();
const operationIdSchema = z
  .uuid()
  .refine((value) => value[14] === "7", "Expected UUIDv7");
const timestampSchema = z.iso.datetime({ offset: true });
const actionUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => {
    const parsed = new URL(value);
    return (
      parsed.username === "" && parsed.password === "" && parsed.hash === ""
    );
  });

const normalizedEmailSchema = z
  .email()
  .max(320)
  .refine(
    (value) => value === value.trim().normalize("NFKC").toLowerCase(),
    "Expected a normalized email",
  );

const reportIntentKindSchema = z.enum(["registration", "recovery"]);

export const reportIdentityTokenHashSchema = base64urlCapabilitySchema;

export function reportIdentityTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export const sendReportLinkRequestSchema = z
  .object({
    operation: z.literal("send"),
    email: normalizedEmailSchema,
    intent_kind: reportIntentKindSchema,
    state: base64urlCapabilitySchema,
  })
  .strict();

export const sendReportLinkResponseSchema = z.union([
  z
    .object({
      status: z.literal("accepted"),
      token_hash: base64urlCapabilitySchema,
    })
    .strict(),
  z
    .object({ status: z.literal("cooldown"), retry_at: timestampSchema })
    .strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);

export const consumeReportLinkRequestSchema = z
  .object({
    operation: z.literal("verify"),
    phase: z.literal("consume"),
    token: rawIdentityTokenSchema,
    email: normalizedEmailSchema,
    intent_kind: reportIntentKindSchema,
    state: base64urlCapabilitySchema,
  })
  .strict();

export const consumeReportLinkResponseSchema = z.union([
  z
    .object({
      status: z.literal("pending"),
      receipt_id: receiptIdSchema,
      completion_deadline: timestampSchema,
    })
    .strict(),
  z.object({ status: z.literal("refused") }).strict(),
]);

export const acknowledgeReportLinkRequestSchema = z
  .object({
    operation: z.literal("verify"),
    phase: z.literal("acknowledge"),
    receipt_id: receiptIdSchema,
    token_hash: base64urlCapabilitySchema,
  })
  .strict();

export const acknowledgeReportLinkResponseSchema = z.union([
  z.object({ status: z.literal("completed") }).strict(),
  z.object({ status: z.literal("refused") }).strict(),
]);

export const verifyReportLinkRequestSchema = z.discriminatedUnion("phase", [
  consumeReportLinkRequestSchema,
  acknowledgeReportLinkRequestSchema,
]);

export const issueCabinetLinkRequestSchema = z
  .object({
    operation: z.literal("issue"),
    receipt_id: receiptIdSchema,
    token_hash: base64urlCapabilitySchema,
  })
  .strict();

export const issueCabinetLinkResponseSchema = z.union([
  z
    .object({ status: z.literal("issued"), action_url: actionUrlSchema })
    .strict(),
  z.object({ status: z.literal("already_attempted") }).strict(),
  z.object({ status: z.literal("refused") }).strict(),
]);

export const deleteUnattachedPersonRequestSchema = z
  .object({
    operation: z.literal("delete"),
    operation_id: operationIdSchema,
    email: normalizedEmailSchema,
  })
  .strict();

export const deleteUnattachedPersonResponseSchema = z.union([
  z.object({ status: z.literal("deleted") }).strict(),
  z.object({ status: z.literal("already_absent") }).strict(),
  z.object({ status: z.literal("retained") }).strict(),
  z.object({ status: z.literal("refused") }).strict(),
]);

export const reportIdentityRequestSchema = z.union([
  sendReportLinkRequestSchema,
  verifyReportLinkRequestSchema,
  issueCabinetLinkRequestSchema,
  deleteUnattachedPersonRequestSchema,
]);

export type SendReportLinkRequest = z.infer<typeof sendReportLinkRequestSchema>;
export type SendReportLinkResponse = z.infer<
  typeof sendReportLinkResponseSchema
>;
export type ConsumeReportLinkRequest = z.infer<
  typeof consumeReportLinkRequestSchema
>;
export type ConsumeReportLinkResponse = z.infer<
  typeof consumeReportLinkResponseSchema
>;
export type AcknowledgeReportLinkRequest = z.infer<
  typeof acknowledgeReportLinkRequestSchema
>;
export type AcknowledgeReportLinkResponse = z.infer<
  typeof acknowledgeReportLinkResponseSchema
>;
export type IssueCabinetLinkRequest = z.infer<
  typeof issueCabinetLinkRequestSchema
>;
export type IssueCabinetLinkResponse = z.infer<
  typeof issueCabinetLinkResponseSchema
>;
export type DeleteUnattachedPersonRequest = z.infer<
  typeof deleteUnattachedPersonRequestSchema
>;
export type DeleteUnattachedPersonResponse = z.infer<
  typeof deleteUnattachedPersonResponseSchema
>;
export type ReportIdentityRequest = z.infer<typeof reportIdentityRequestSchema>;
