/** Private dashboard admission facts; none is part of the merchant wire contract. */
import { ServiceNameSchema } from "@nuanu-ai/agentify-contracts";
import { z } from "zod";
import {
  checkedJournalEntry,
  type JournalPress,
  JournalReasonSchema,
  type JournalRow,
  settledPress,
} from "./journal.js";

import type { StoredMerchant } from "./store.js";

const instant = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const LiveSalesEvidenceSchema = z.discriminatedUnion("integration", [
  z.object({ integration: z.literal("api"), connectedAt: instant }),
  z
    .object({
      integration: z.literal("woocommerce"),
      host: z
        .string()
        .min(1)
        .max(253)
        .regex(/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/),
      checkedAt: instant,
      ready: count,
      read: count,
      total: count.nullable(),
      complete: z.boolean(),
    })
    .refine(
      (value) => value.ready <= value.read && (value.total === null || value.read <= value.total),
      "checked product counts must agree",
    )
    .refine(
      (value) => !value.complete || value.total === value.read,
      "a complete check has read its known total",
    ),
]);
export type LiveSalesEvidence = z.infer<typeof LiveSalesEvidenceSchema>;
export interface LiveSalesRequest {
  readonly id: string;
  readonly merchantId: string;
  readonly accountId: string | null;
  readonly requestedAt: number;
  readonly evidence: LiveSalesEvidence | null;
  readonly state: "pending" | "declined" | "admitted";
  readonly decline: JournalRow | null;
  readonly reminderDueAt: number;
  readonly reminderCreatedAt: number | null;
}
export interface LiveSalesAsk {
  readonly merchantId: string;
  readonly accountId: string;
  readonly sellerName: string;
  readonly evidence: LiveSalesEvidence | null;
}
export type LiveSalesAsked =
  | Readonly<{ kind: "requested" | "pending"; request: LiveSalesRequest }>
  | Readonly<{ kind: "missing" | "approved" | "moved" }>;
export interface LiveSalesDeclined {
  readonly changed: boolean;
  readonly request: LiveSalesRequest | null;
}
export interface LiveSalesNotice {
  readonly kind: "requested" | "declined";
  readonly request: LiveSalesRequest;
  readonly sellerName: string;
  readonly hasWallet: boolean;
}
export interface LiveSalesChange {
  readonly kind: "admitted" | "first_wallet" | "withdrawn";
  readonly approvalAt: number | null;
  readonly id: string;
  readonly merchantId: string;
  readonly at: number;
  readonly sellerName: string | null;
  readonly sellerSite: string | null;
  readonly integration: StoredMerchant["integration"];
  readonly hasWallet: boolean;
  readonly reason: string | null;
}
export type LiveSalesEffect = LiveSalesNotice | LiveSalesChange;
export function liveSalesChange(
  kind: LiveSalesChange["kind"],
  id: string,
  merchant: Pick<
    StoredMerchant,
    "id" | "serviceName" | "sellerSite" | "integration" | "liveApprovedAt"
  > & { readonly payoutWallet: { readonly address: string | null } },
  at: number,
  reason: string | null = null,
): LiveSalesChange {
  return {
    kind,
    id,
    merchantId: merchant.id,
    approvalAt: kind === "admitted" ? at : kind === "withdrawn" ? null : merchant.liveApprovedAt,
    at,
    sellerName: merchant.serviceName,
    sellerSite: merchant.sellerSite,
    integration: merchant.integration,
    hasWallet: merchant.payoutWallet.address !== null,
    reason,
  };
}
/** Two Monday–Friday dates after the request, preserving its UTC clock time. */
export function liveSalesReminderAt(at: number): number {
  const day = new Date(at);
  for (let left = 2; left > 0; ) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) left--;
  }
  return day.getTime();
}
export function checkedLiveSalesAsk(
  input: LiveSalesAsk,
  at: number,
): asserts input is LiveSalesAsk & { evidence: LiveSalesEvidence } {
  instant.parse(at);
  z.string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .parse(input.accountId);
  ServiceNameSchema.parse(input.sellerName);
  if (input.evidence === null)
    throw new Error("a new live-sales request needs connection evidence");
  LiveSalesEvidenceSchema.parse(input.evidence);
  if (input.evidence.integration === "woocommerce" && input.evidence.ready === 0)
    throw new Error("a live-sales request needs a checked ready product");
}
export function checkedDecline(merchantId: string, press: JournalPress): void {
  if (
    press.action !== "decline" ||
    press.subject.kind !== "merchant" ||
    press.subject.id !== merchantId
  )
    throw new Error("a decline must name this merchant");
  JournalReasonSchema.parse(press.reason);
  checkedJournalEntry(settledPress(press, true));
}
