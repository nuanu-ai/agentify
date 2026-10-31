/**
 * A live-sales decision and its recipient rows commit together. Provider
 * handover happens later, using a frozen message and stable key. A provider
 * timeout can still duplicate delivery after its one-day deduplication window.
 */
import { createHash } from "node:crypto";
import { failureNamed } from "@agentify/gateway/failure-named";
import {
  type LiveSalesNotice,
  type LiveSalesTransaction,
  liveRequestOf,
  liveRequests,
  type PostgresLiveSalesNotices,
} from "@agentify/gateway/live-sales";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { DashboardConfig } from "./config.js";
import { type Handover, isSandboxMail, type Message, type Postman, postmanFor } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";
import { momentInUtc } from "./moments.js";
import { accounts, liveSalesMail } from "./schema.js";

export type LiveSalesMailEvent = Omit<LiveSalesNotice, "kind"> & {
  readonly kind: LiveSalesNotice["kind"] | "reminder";
};

type MailConfig = Pick<
  DashboardConfig,
  "surfaceMode" | "publicBaseUrl" | "basePath" | "mailFrom" | "mailUrl"
>;
type Delivery = typeof liveSalesMail.$inferSelect;
const date = (at: number): string => momentInUtc(new Date(at).toISOString());
const number = (count: number): string => count.toLocaleString("en-US");

/** Used by the durable sender and the gallery, with the same dated facts. */
export function liveSalesMessage(parts: {
  readonly to: string;
  readonly event: LiveSalesMailEvent;
  readonly requesterEmail: string | null;
  readonly baseUrl: string;
  readonly idempotencyKey: string;
}): Message {
  const { event, requesterEmail, baseUrl } = parts;
  const { request, sellerName, kind } = event;
  const operator = kind !== "declined";
  const link = operator ? `${baseUrl}/admin/merchants/${request.merchantId}` : baseUrl;
  let subject: string;
  let lead: string;
  let paragraphs: string[];
  if (kind === "declined") {
    const decline = request.decline;
    if (decline?.reason == null) throw new Error("a decline email needs its recorded note");
    subject = `Agentify didn't approve ${sellerName} for live sales`;
    lead = `Agentify looked at your request for live sales on ${date(decline.at)} and didn't approve it.`;
    paragraphs = [
      `Note from Agentify:\n${decline.reason}`,
      "Fix what the note asks, then ask again from your dashboard.",
    ];
  } else if (kind === "reminder") {
    subject = `${sellerName} has waited two working days`;
    lead = `${sellerName} asked for live sales on ${date(request.requestedAt)}, and nobody has answered.`;
    paragraphs = ["Their screen says we usually reply within one or two working days."];
  } else {
    subject = `${sellerName} asked for live sales`;
    lead =
      request.accountId === null
        ? `Agentify recorded ${sellerName}'s existing pending request on ${date(request.requestedAt)}.`
        : `${sellerName}${requesterEmail === null ? "" : ` (${requesterEmail})`} asked on ${date(request.requestedAt)}.`;
    const evidence = request.evidence;
    if (evidence === null) {
      paragraphs = ["We don't have a recorded catalog check or code connection for this request."];
    } else if (evidence.integration === "api") {
      paragraphs = [`Their code connected ${date(evidence.connectedAt)}.`];
    } else {
      paragraphs = evidence.complete
        ? [
            `${number(evidence.ready)} of ${number(evidence.total ?? evidence.read)} products in ${evidence.host} checked ready.`,
          ]
        : [
            `${number(evidence.ready)} of the ${number(evidence.read)} products read from ${evidence.host} checked ready.`,
            "We don't know about the rest yet.",
          ];
      paragraphs.push(`Checked ${date(evidence.checkedAt)}.`);
    }
    if (!event.hasWallet) paragraphs.push("No payout wallet yet.");
  }
  const action = operator ? `Open ${sellerName} in the admin` : "Ask again in your dashboard";
  const reason = operator
    ? "You get this email because you are an operator of Agentify's live channel."
    : "You get this email because you asked Agentify for live sales.";
  return {
    to: parts.to,
    subject,
    body: ["Agentify", subject, lead, ...paragraphs, `${action}:\n${link}`, reason].join("\n\n"),
    html: transactionalEmailHtml(
      {
        preview: lead,
        eyebrow: "Live sales",
        title: subject,
        lead,
        paragraphs,
        action,
        link,
        reason,
      },
      { paragraphsBeforeAction: true },
    ),
    idempotencyKey: parts.idempotencyKey,
  };
}

const noticeId = (event: LiveSalesMailEvent, accountId: string): string =>
  `live-sales-${createHash("sha256").update(`${event.request.id}:${event.kind}:${accountId}`).digest("hex")}`;

async function insertNotices(
  tx: LiveSalesTransaction,
  event: LiveSalesMailEvent,
  at: Date,
): Promise<void> {
  const requesterId = event.request.accountId;
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
    requester?.merchantId !== event.request.merchantId
  ) {
    throw new Error("the requesting account no longer names this merchant");
  }
  const recipients = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      event.kind === "declined"
        ? eq(accounts.merchantId, event.request.merchantId)
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
        requestId: event.request.id,
        merchantId: event.request.merchantId,
        recipientAccountId: id,
        requesterAccountId:
          requester?.merchantId === event.request.merchantId ? requester.id : null,
        kind: event.kind,
        event,
        state: "pending" as const,
        createdAt: at,
        nextAttemptAt: at,
      })),
    )
    .onConflictDoNothing();
}

/** Every query uses the business write's transaction, including recipient lookup. */
export function postgresLiveSalesNotices(
  config: Pick<MailConfig, "surfaceMode">,
): PostgresLiveSalesNotices {
  return {
    async within(tx, event) {
      if (config.surfaceMode !== "live")
        throw new Error("live-sales notices belong to the live channel");
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
    (row.kind === "declined" ? recipient.merchantId !== row.merchantId : !recipient.operator)
  )
    return "role_changed";
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
