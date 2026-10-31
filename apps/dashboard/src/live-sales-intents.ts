import { createHash } from "node:crypto";
import type { LiveSalesTransaction } from "@agentify/gateway/live-sales";
import { eq } from "drizzle-orm";
import {
  eventId,
  eventMerchant,
  type LiveSalesMailEvent,
  operatorMail,
} from "./live-sales-events.js";
import { accounts, liveSalesMail } from "./schema.js";

const noticeId = (event: LiveSalesMailEvent, accountId: string): string =>
  `live-sales-${createHash("sha256")
    .update(`${eventId(event)}:${event.kind}:${accountId}`)
    .digest("hex")}`;

export async function insertNotices(
  tx: LiveSalesTransaction,
  event: LiveSalesMailEvent,
  at: Date,
): Promise<void> {
  const requesterId = "request" in event ? event.request.accountId : null;
  const [requester] =
    requesterId === null
      ? []
      : await tx
          .select({ id: accounts.id, merchantId: accounts.merchantId })
          .from(accounts)
          .where(eq(accounts.id, requesterId));
  if (
    event.kind === "requested" &&
    requesterId !== null &&
    requester?.merchantId !== eventMerchant(event)
  ) {
    throw new Error("the requesting account no longer names this merchant");
  }
  const recipients = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      !operatorMail(event.kind)
        ? eq(accounts.merchantId, eventMerchant(event))
        : eq(accounts.operator, true),
    );
  if (recipients.length === 0) {
    console.log(`[dashboard] live-sales ${event.kind}: no eligible recipient accounts`);
    return;
  }
  await tx
    .insert(liveSalesMail)
    .values(
      recipients.map(({ id }) => ({
        id: noticeId(event, id),
        requestId: eventId(event),
        merchantId: eventMerchant(event),
        recipientAccountId: id,
        requesterAccountId: requester?.merchantId === eventMerchant(event) ? requester.id : null,
        kind: event.kind,
        event,
        state: "pending" as const,
        createdAt: at,
        nextAttemptAt: at,
      })),
    )
    .onConflictDoNothing();
}
