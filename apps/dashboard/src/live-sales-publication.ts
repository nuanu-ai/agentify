/** Admission and first-wallet publication share the existing bounded shop worker. */

import { failureNamed } from "@agentify/gateway/failure-named";
import {
  type LiveSalesChange,
  type LiveSalesTransaction,
  liveRequests,
} from "@agentify/gateway/live-sales";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { DecisionMailEvent } from "./live-sales-events.js";
import { insertNotices } from "./live-sales-intents.js";
import { accounts, livePublications, liveSalesMail, shopJobProducts, wooShops } from "./schema.js";
import { type JobProduct, jobIsCurrent, type ShopJob } from "./shop-jobs.js";
import type { WooShops } from "./woo-shops.js";

export function publicationMailEvent(
  event: LiveSalesChange,
  job: ShopJob,
  rows: readonly JobProduct[],
): DecisionMailEvent {
  if (job.status !== "completed" && job.status !== "stopped")
    throw new Error("publication mail requires terminal facts");
  return {
    ...event,
    kind: event.kind === "admitted" ? "admitted" : "published",
    next: "products",
    publication: {
      at: new Date(job.endedAt ?? event.at).getTime(),
      host: new URL(job.shopUrl).host,
      status: job.status,
      read: job.read,
      total: job.total,
      published: rows.filter((row) => row.published).length,
      fix: rows.filter((row) => row.group === "fix").length,
      stopCode: job.stopCode,
      why: job.why,
    },
  };
}
const decision = (event: LiveSalesChange, next: DecisionMailEvent["next"]): DecisionMailEvent => ({
  ...event,
  kind: event.kind === "first_wallet" ? "published" : event.kind,
  next,
  publication: null,
});

/** The caller holds the merchant write lock; no remote I/O happens in this transaction. */
export async function recordLiveSalesChange(
  tx: LiveSalesTransaction,
  event: LiveSalesChange,
): Promise<void> {
  const at = new Date(event.at);
  if (event.kind === "admitted")
    await tx
      .update(liveSalesMail)
      .set({ state: "suppressed", suppression: "decision_changed", settledAt: at })
      .where(
        and(
          eq(liveSalesMail.merchantId, event.merchantId),
          eq(liveSalesMail.kind, "withdrawn"),
          eq(liveSalesMail.state, "pending"),
        ),
      );
  if (event.kind === "withdrawn") {
    if (event.reason === null || event.reason.trim() === "")
      throw new Error("a withdrawal needs its recorded operator note");
    await tx
      .update(livePublications)
      .set({ state: "completed" })
      .where(
        and(
          eq(livePublications.merchantId, event.merchantId),
          eq(livePublications.state, "pending"),
        ),
      );
    await tx
      .update(liveSalesMail)
      .set({ state: "suppressed", suppression: "decision_changed", settledAt: at })
      .where(
        and(
          eq(liveSalesMail.merchantId, event.merchantId),
          eq(liveSalesMail.state, "pending"),
          sql`${liveSalesMail.kind} in ('admitted', 'published')`,
        ),
      );
    await insertNotices(tx, decision(event, "products"), at);
    return;
  }
  if (event.kind === "first_wallet" && event.integration !== "woocommerce") return;
  // A code merchant's site is asked by the publish door, with an async or parcel card in hand.
  if (
    event.sellerName === null ||
    (event.integration === "woocommerce" && event.sellerSite === null)
  ) {
    await insertNotices(tx, decision(event, "settings"), at);
    return;
  }
  if (!event.hasWallet) {
    await insertNotices(tx, decision(event, "wallet"), at);
    return;
  }
  const [recipient] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.merchantId, event.merchantId))
    .orderBy(asc(accounts.id))
    .limit(1);
  if (!recipient) {
    console.log(`[dashboard] live-sales ${event.kind}: no eligible recipient accounts`);
    return;
  }
  if (event.integration === "api") {
    const {
      rows: [keys],
    } = await tx.execute<{ connected: boolean }>(
      sql`select exists(select 1 from merchant_keys where merchant_id=${event.merchantId} and disabled_at is null) as connected`,
    );
    await insertNotices(tx, decision(event, keys?.connected ? "code" : "connect"), at);
    return;
  }
  const connections = await tx
    .select({ accountId: wooShops.accountId })
    .from(wooShops)
    .innerJoin(accounts, eq(accounts.id, wooShops.accountId))
    .where(eq(accounts.merchantId, event.merchantId));
  if (connections.length === 0) {
    await insertNotices(tx, decision(event, "connect"), at);
    return;
  }
  const [request] = await tx
    .select({ accountId: liveRequests.accountId })
    .from(liveRequests)
    .where(and(eq(liveRequests.merchantId, event.merchantId), eq(liveRequests.state, "admitted")));
  const connection =
    connections.find((one) => one.accountId === request?.accountId) ??
    (connections.length === 1 ? connections[0] : undefined);
  if (!connection) {
    await insertNotices(tx, decision(event, "choose"), at);
    return;
  }
  await tx
    .insert(livePublications)
    .values({
      id: event.id,
      merchantId: event.merchantId,
      accountId: connection.accountId,
      event,
      createdAt: at,
    })
    .onConflictDoNothing();
}

/** Called before terminal job state commits, so replacement cannot discard the mail's counts. */
export async function captureLivePublication(
  tx: LiveSalesTransaction,
  job: ShopJob,
): Promise<void> {
  if (job.kind !== "publish" || job.publicationId === undefined) return;
  const [intent] = await tx
    .select()
    .from(livePublications)
    .where(eq(livePublications.id, job.publicationId))
    .for("update");
  if (intent?.state !== "pending" || intent.jobId !== job.id) return;
  const rows = await tx
    .select({ data: shopJobProducts.data })
    .from(shopJobProducts)
    .where(eq(shopJobProducts.jobId, job.id));
  await insertNotices(
    tx,
    publicationMailEvent(
      intent.event,
      job,
      rows.map((row) => row.data),
    ),
    new Date(job.endedAt ?? Date.now()),
  );
  await tx
    .update(livePublications)
    .set({ state: "completed" })
    .where(eq(livePublications.id, intent.id));
}

type Database = NodePgDatabase;

/**
 * Every waiting trigger, so one merchant's running check delays no other
 * merchant; the shop workers bound how many of the jobs asked for here run.
 */
export async function advanceLivePublication(pool: Pool, shops: WooShops): Promise<void> {
  const db = drizzle(pool);
  const intents = await db
    .select()
    .from(livePublications)
    .where(and(eq(livePublications.state, "pending"), sql`${livePublications.jobId} is null`))
    .orderBy(asc(livePublications.createdAt));
  for (const intent of intents)
    try {
      await advanceOne(db, shops, intent);
    } catch (error) {
      // The intent stays pending for the next turn; one merchant must not hold up the rest.
      console.error(
        `[dashboard] an automatic publication could not be advanced: ${failureNamed(error)}`,
      );
    }
}

/** An active check never consumes the trigger. */
async function advanceOne(
  db: Database,
  shops: WooShops,
  intent: typeof livePublications.$inferSelect,
): Promise<void> {
  const settle = async (next: DecisionMailEvent["next"]) =>
    db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(livePublications)
        .where(eq(livePublications.id, intent.id))
        .for("update");
      if (current?.state !== "pending" || current.jobId !== null) return;
      await insertNotices(tx, decision(current.event, next), new Date());
      await tx
        .update(livePublications)
        .set({ state: "completed" })
        .where(eq(livePublications.id, current.id));
    });
  const {
    rows: [merchant],
  } = await db.execute<{
    live_approved_at: Date | null;
    integration: string;
    service_name: string | null;
    seller_site: string | null;
    payout_wallet: string | null;
  }>(
    sql`select live_approved_at,integration,service_name,seller_site,payout_wallet from merchants where id=${intent.merchantId}`,
  );
  const [owner] = await db
    .select({ merchantId: accounts.merchantId })
    .from(accounts)
    .where(eq(accounts.id, intent.accountId));
  const inForce = (approvedAt: Date | null | undefined) =>
    approvedAt != null && new Date(approvedAt).getTime() === intent.event.approvalAt;
  if (inForce(merchant?.live_approved_at) && merchant?.integration !== "woocommerce")
    return db.transaction(async (tx) => {
      const {
        rows: [now],
      } = await tx.execute<{
        live_approved_at: Date | null;
        integration: LiveSalesChange["integration"];
        service_name: string | null;
        seller_site: string | null;
        payout_wallet: string | null;
      }>(
        sql`select live_approved_at,integration,service_name,seller_site,payout_wallet from merchants where id=${intent.merchantId} for no key update`,
      );
      const [current] = await tx
        .select()
        .from(livePublications)
        .where(eq(livePublications.id, intent.id))
        .for("update");
      if (current?.state !== "pending" || current.jobId !== null) return;
      // Back on WooCommerce since the read above: the next turn publishes the shop.
      if (!now || now.integration === "woocommerce") return;
      await recordLiveSalesChange(tx, {
        ...current.event,
        integration: now.integration,
        sellerName: now.service_name,
        sellerSite: now.seller_site,
        hasWallet: now.payout_wallet !== null,
      });
      await tx
        .update(livePublications)
        .set({ state: "completed" })
        .where(eq(livePublications.id, current.id));
    });
  if (
    !merchant ||
    !inForce(merchant.live_approved_at) ||
    merchant.integration !== "woocommerce" ||
    owner?.merchantId !== intent.merchantId
  ) {
    await db
      .update(livePublications)
      .set({ state: "completed" })
      .where(eq(livePublications.id, intent.id));
    return;
  }
  if (merchant.service_name === null || merchant.seller_site === null) return settle("settings");
  if (merchant.payout_wallet === null) return settle("wallet");
  const connection = await shops.connectionOf(intent.accountId);
  if (connection?.permissions !== "read_write") return settle("connect");
  const snapshots = await shops.jobs.snapshots(intent.merchantId);
  if (snapshots.some(({ job }) => job.status === "running" || job.status === "queued")) return;
  const checked = snapshots.find(
    ({ job }) => job.kind === "check" && job.connectionRevision === connection.revision,
  )?.job;
  if (checked && checked.stopCode === "rate_required") {
    const rate =
      checked.currency &&
      (await shops.currentRate(
        intent.accountId,
        new URL(connection.shopUrl).origin,
        checked.currency.code,
      ));
    if (!rate) return settle("products");
  }
  if (!checked || !(await jobIsCurrent(shops, checked))) {
    await shops.jobs.request({
      merchantId: intent.merchantId,
      accountId: intent.accountId,
      connectionRevision: connection.revision,
      shopUrl: connection.shopUrl,
      kind: "check",
    });
    return;
  }
  if (
    checked.currency === null ||
    (checked.currency.code !== "USD" && checked.rate === null) ||
    checked.stopCode === "reconnect" ||
    checked.stopCode === "rate_required"
  )
    return settle("products");
  await shops.jobs.request({
    merchantId: intent.merchantId,
    accountId: intent.accountId,
    connectionRevision: connection.revision,
    shopUrl: connection.shopUrl,
    kind: "publish",
    currency: checked.currency,
    rate: checked.rate,
    publicationId: intent.id,
  });
}

/** Private Products read while an automatic publication waits behind a check. */
export async function livePublicationPending(pool: Pool, merchantId: string): Promise<boolean> {
  const [pending] = await drizzle(pool)
    .select({ id: livePublications.id })
    .from(livePublications)
    .where(and(eq(livePublications.merchantId, merchantId), eq(livePublications.state, "pending")))
    .limit(1);
  return pending !== undefined;
}
