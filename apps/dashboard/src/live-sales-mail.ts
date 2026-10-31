/**
 * A live-sales decision and its recipient rows commit together. Provider
 * handover happens later, using a frozen message and stable key. A provider
 * timeout can still duplicate delivery after its one-day deduplication window.
 */
import { failureNamed } from "@agentify/gateway/failure-named";
import {
  type LiveSalesTransaction,
  liveRequestOf,
  liveRequests,
  type PostgresLiveSalesNotices,
} from "@agentify/gateway/live-sales";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { DashboardConfig } from "./config.js";
import { operatorMail } from "./live-sales-events.js";
import { insertNotices } from "./live-sales-intents.js";
import { recordLiveSalesChange } from "./live-sales-publication.js";
import { type Handover, isSandboxMail, type Postman, postmanFor } from "./mail.js";
import { accounts, liveSalesMail } from "./schema.js";

type MailConfig = Pick<
  DashboardConfig,
  "surfaceMode" | "publicBaseUrl" | "basePath" | "mailFrom" | "mailUrl"
>;
type Delivery = typeof liveSalesMail.$inferSelect;

import { liveSalesMessage } from "./live-sales-message.js";

/** Every query uses the business write's transaction, including recipient lookup. */
export function postgresLiveSalesNotices(
  config: Pick<MailConfig, "surfaceMode">,
): PostgresLiveSalesNotices {
  return {
    async within(tx, event) {
      if (config.surfaceMode !== "live") {
        if (!("request" in event)) return;
        throw new Error("live-sales notices belong to the live channel");
      }
      if (!("request" in event)) return recordLiveSalesChange(tx, event);
      await insertNotices(
        tx,
        event,
        new Date(
          event.kind === "declined"
            ? (event.request.decline?.at ?? event.request.requestedAt)
            : event.request.requestedAt,
        ),
      );
    },
  };
}

async function remindOne(pool: Pool, now: Date): Promise<void> {
  await drizzle(pool).transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(liveRequests)
      .where(
        and(
          eq(liveRequests.state, "pending"),
          isNull(liveRequests.reminderCreatedAt),
          lte(liveRequests.reminderDueAt, now),
        ),
      )
      .orderBy(asc(liveRequests.requestedAt), asc(liveRequests.merchantId))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return;
    const {
      rows: [merchant],
    } = await tx.execute<{ service_name: string | null; payout_wallet: string | null }>(
      sql`select service_name, payout_wallet from merchants where id = ${row.merchantId}`,
    );
    if (!merchant) throw new Error("a live-sales request has no merchant");
    await insertNotices(
      tx,
      {
        kind: "reminder",
        request: liveRequestOf(row, null),
        sellerName: merchant.service_name ?? row.merchantId,
        hasWallet: merchant.payout_wallet !== null,
      },
      now,
    );
    await tx
      .update(liveRequests)
      .set({ reminderCreatedAt: now })
      .where(eq(liveRequests.id, row.id));
  });
}

/** Reading role flags takes no account lock: erasure locks accounts before cascading to mail. */
async function eligible(
  tx: LiveSalesTransaction,
  row: Delivery,
  config: MailConfig,
): Promise<
  | { readonly email: string }
  | "role_changed"
  | "decision_changed"
  | "request_answered"
  | "address_changed"
  | "sender_changed"
  | "provider_changed"
> {
  const [recipient] = await tx
    .select({ email: accounts.email, operator: accounts.operator, merchantId: accounts.merchantId })
    .from(accounts)
    .where(eq(accounts.id, row.recipientAccountId));
  if (
    !recipient ||
    (!operatorMail(row.kind) ? recipient.merchantId !== row.merchantId : !recipient.operator)
  )
    return "role_changed";
  if (!("request" in row.event)) {
    const {
      rows: [merchant],
    } = await tx.execute<{ live_approved_at: Date | null }>(
      sql`select live_approved_at from merchants where id=${row.merchantId}`,
    );
    const approvedAt =
      merchant?.live_approved_at == null ? null : new Date(merchant.live_approved_at).getTime();
    if (
      row.event.kind === "withdrawn"
        ? approvedAt !== null
        : approvedAt === null || approvedAt !== row.event.approvalAt
    )
      return "decision_changed";
  }
  if (row.kind === "reminder") {
    const [pending] = await tx
      .select({ id: liveRequests.id })
      .from(liveRequests)
      .where(and(eq(liveRequests.id, row.requestId), eq(liveRequests.state, "pending")));
    if (!pending) return "request_answered";
  }
  if (row.message !== null && row.message.to !== recipient.email) return "address_changed";
  if (row.message !== null && row.preparedFrom !== config.mailFrom) return "sender_changed";
  if (row.message !== null && row.preparedProvider !== config.mailUrl) return "provider_changed";
  return { email: recipient.email };
}

async function suppressed(
  tx: LiveSalesTransaction,
  row: Delivery,
  reason: string,
  now: Date,
): Promise<void> {
  await tx
    .update(liveSalesMail)
    .set({ state: "suppressed", suppression: reason, settledAt: now })
    .where(eq(liveSalesMail.id, row.id));
}

interface DeliveryParts {
  readonly pool: Pool;
  readonly config: MailConfig;
  readonly postman: Postman;
  readonly now?: () => Date;
}

/** One production turn; a true result means a due delivery was handled. */
export async function deliverLiveSalesMail(parts: DeliveryParts): Promise<boolean> {
  if (parts.config.surfaceMode !== "live" || isSandboxMail(parts.config.mailUrl)) return false;
  const now = parts.now ?? (() => new Date());
  await remindOne(parts.pool, now());
  const db = drizzle(parts.pool);
  // Freeze before handover in its own commit: after a process exit, retries
  // still carry the provider's original bytes even if a name/template changed.
  const prepared = await db.transaction(async (tx) => {
    const at = now();
    const [row] = await tx
      .select()
      .from(liveSalesMail)
      .where(and(eq(liveSalesMail.state, "pending"), lte(liveSalesMail.nextAttemptAt, at)))
      .orderBy(asc(liveSalesMail.nextAttemptAt), asc(liveSalesMail.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    const recipient = await eligible(tx, row, parts.config);
    if (typeof recipient === "string") {
      await suppressed(tx, row, recipient, at);
      return { id: row.id, send: false };
    }
    if (row.message === null) {
      const [requester] =
        row.requesterAccountId === null
          ? []
          : await tx
              .select({ email: accounts.email, merchantId: accounts.merchantId })
              .from(accounts)
              .where(eq(accounts.id, row.requesterAccountId));
      const message = liveSalesMessage({
        to: recipient.email,
        event: row.event,
        requesterEmail: requester?.merchantId === row.merchantId ? requester.email : null,
        baseUrl: `${parts.config.publicBaseUrl}${parts.config.basePath}`,
        idempotencyKey: row.id,
      });
      await tx
        .update(liveSalesMail)
        .set({
          message,
          preparedAt: at,
          preparedFrom: parts.config.mailFrom,
          preparedProvider: parts.config.mailUrl,
        })
        .where(eq(liveSalesMail.id, row.id));
    }
    return { id: row.id, send: true };
  });
  if (!prepared) return false;
  if (!prepared.send) return true;
  await db.transaction(async (tx) => {
    const at = now();
    const [row] = await tx
      .select()
      .from(liveSalesMail)
      .where(
        and(
          eq(liveSalesMail.id, prepared.id),
          eq(liveSalesMail.state, "pending"),
          lte(liveSalesMail.nextAttemptAt, at),
        ),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return;
    const recipient = await eligible(tx, row, parts.config);
    if (typeof recipient === "string") return await suppressed(tx, row, recipient, at);
    if (row.message === null) throw new Error("a live-sales email was not frozen before handover");
    let outcome: Handover;
    try {
      outcome = await parts.postman(row.message);
    } catch {
      outcome = "unknown";
    }
    const settledAt = now();
    const attempts = row.attempts + 1;
    await tx
      .update(liveSalesMail)
      .set({
        attempts,
        lastOutcome: outcome,
        lastAttemptAt: at,
        state: outcome === "accepted" ? "accepted" : "pending",
        settledAt: outcome === "accepted" ? settledAt : null,
        nextAttemptAt: new Date(
          settledAt.getTime() + Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(attempts - 1, 9)),
        ),
      })
      .where(eq(liveSalesMail.id, row.id));
  });
  return true;
}

/** Owns only the live-sales mail loop; shutdown waits for the bounded provider call. */
export function startLiveSalesMail(parts: {
  readonly pool: Pool;
  readonly config: DashboardConfig;
}): { stop(): Promise<void> } {
  if (parts.config.surfaceMode !== "live") return { stop: async () => undefined };
  if (isSandboxMail(parts.config.mailUrl)) {
    console.log(
      "[dashboard] live-sales mail is waiting for a mail provider; private messages stay in the database",
    );
    return { stop: async () => undefined };
  }
  let running = true;
  let wake: (() => void) | undefined;
  const postman = postmanFor(parts.config);
  const done = (async () => {
    while (running) {
      let took = false;
      try {
        took = await deliverLiveSalesMail({ ...parts, postman });
      } catch (error) {
        console.error(`[dashboard] a live-sales mail turn failed: ${failureNamed(error)}`);
      }
      if (!took && running)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      wake = undefined;
    }
  })();
  return {
    async stop() {
      running = false;
      wake?.();
      await done;
    },
  };
}
