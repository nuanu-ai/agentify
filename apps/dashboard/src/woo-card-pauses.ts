/** Connector pause ownership lives with the connector; the gateway holds only a normal card pause. */
import type { Gateway } from "@agentify/gateway";
import { type AnalyticsEvent, recordAlong } from "@agentify/gateway/analytics";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

type CardStore = Pick<Gateway["runtime"]["store"], "cardById" | "setCardPaused">;
const changed = (merchantId: string, itemId: string, paused: boolean): AnalyticsEvent => ({
  name: "agc_selling_changed",
  actor: "system",
  source: "woocommerce",
  refs: { merchant: merchantId, item: itemId },
  fields: { entity: "card", change: paused ? "paused" : "resumed" },
});

export type WooWithdrawalReason = "stopped_selling" | "changed";
export interface WooCardPause {
  readonly at: number;
  readonly reason: WooWithdrawalReason;
}
interface PauseOwnership {
  readonly pause: WooCardPause | null;
  save(pause: WooCardPause | null): Promise<void>;
}
export interface WooCardPauses {
  set(
    merchantId: string,
    itemId: string,
    reason: WooWithdrawalReason | null,
    store: CardStore,
  ): Promise<void>;
  list(merchantId: string): Promise<Readonly<Record<string, WooCardPause>>>;
  withLock<T>(
    merchantId: string,
    itemId: string,
    work: (ownership: PauseOwnership) => Promise<T>,
  ): Promise<T>;
}
/** The memory adapter serializes dashboard actions; the deployed database also observes API writes. */
export function memoryWooCardPauses(): WooCardPauses {
  const rows = new Map<string, Map<string, WooCardPause>>();
  const locks = new Map<string, Promise<unknown>>();
  const pauses: WooCardPauses = {
    async set(merchantId, itemId, reason, store) {
      const paused = reason !== null;
      await pauses.withLock(merchantId, itemId, async (ownership) => {
        const card = await store.cardById(itemId);
        if (!card || card.merchantId !== merchantId || card.integration !== "woocommerce") return;
        if (paused && card.paused) {
          if (ownership.pause) await ownership.save({ ...ownership.pause, reason });
          return;
        }
        if (!paused && ownership.pause === null) return;
        await store.setCardPaused(merchantId, itemId, paused, changed(merchantId, itemId, paused));
        await ownership.save(reason === null ? null : { at: Date.now(), reason });
      });
    },
    async list(merchantId) {
      return Object.fromEntries(rows.get(merchantId) ?? []);
    },
    async withLock(merchantId, itemId, work) {
      const key = JSON.stringify([merchantId, itemId]);
      const before = locks.get(key) ?? Promise.resolve();
      const running = before
        .catch(() => undefined)
        .then(async () => {
          let row = rows.get(merchantId);
          if (!row) {
            row = new Map();
            rows.set(merchantId, row);
          }
          return work({
            pause: row.get(itemId) ?? null,
            async save(pause) {
              if (pause === null) row.delete(itemId);
              else row.set(itemId, pause);
            },
          });
        });
      locks.set(key, running);
      try {
        return await running;
      } finally {
        if (locks.get(key) === running) locks.delete(key);
      }
    },
  };
  return pauses;
}
export function postgresWooCardPauses(pool: Pool): WooCardPauses {
  const pauses: WooCardPauses = {
    async set(merchantId, itemId, reason) {
      const paused = reason !== null;
      const key = JSON.stringify(["dashboard_woo_card_pause", merchantId, itemId]);
      await drizzle(pool).transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
        const before = (
          await tx.execute<{ paused: boolean }>(
            sql`select paused from cards where merchant_id=${merchantId} and id=${itemId} and integration='woocommerce' for no key update`,
          )
        ).rows[0];
        if (!before) return;
        const owned =
          (
            await tx.execute(
              sql`select item_id from dashboard_woo_card_pauses where merchant_id=${merchantId} and item_id=${itemId}`,
            )
          ).rows.length > 0;
        if (paused && before.paused) {
          if (owned)
            await tx.execute(
              sql`update dashboard_woo_card_pauses set reason=${reason} where merchant_id=${merchantId} and item_id=${itemId}`,
            );
          return;
        }
        if (!paused && !owned) return;
        // A normal card update clears ownership through the dashboard's trigger, even for an API seller pause.
        await tx.execute(
          sql`update cards set paused=${paused} where merchant_id=${merchantId} and id=${itemId}`,
        );
        const at = new Date();
        if (paused)
          await tx.execute(
            sql`insert into dashboard_woo_card_pauses (merchant_id,item_id,paused_at,reason) values (${merchantId},${itemId},${at},${reason})`,
          );
        if (before.paused !== paused)
          await recordAlong(tx, changed(merchantId, itemId, paused), at);
      });
    },
    async list(merchantId) {
      const result = await pool.query<{
        item_id: string;
        paused_at: Date;
        reason: WooWithdrawalReason;
      }>("select item_id, paused_at, reason from dashboard_woo_card_pauses where merchant_id=$1", [
        merchantId,
      ]);
      return Object.fromEntries(
        result.rows.map((row) => [
          row.item_id,
          { at: row.paused_at.getTime(), reason: row.reason },
        ]),
      );
    },
    async withLock(merchantId, itemId, work) {
      const client = await pool.connect();
      const key = JSON.stringify(["dashboard_woo_card_pause", merchantId, itemId]);
      try {
        await client.query("select pg_advisory_lock(hashtextextended($1,0))", [key]);
        const result = await client.query<{ paused_at: Date; reason: WooWithdrawalReason }>(
          "select paused_at, reason from dashboard_woo_card_pauses where merchant_id=$1 and item_id=$2",
          [merchantId, itemId],
        );
        return await work({
          pause: result.rows[0]
            ? { at: result.rows[0].paused_at.getTime(), reason: result.rows[0].reason }
            : null,
          async save(pause) {
            if (pause === null)
              await client.query(
                "delete from dashboard_woo_card_pauses where merchant_id=$1 and item_id=$2",
                [merchantId, itemId],
              );
            else
              await client.query(
                "insert into dashboard_woo_card_pauses (merchant_id,item_id,paused_at,reason) values ($1,$2,$3,$4) on conflict (merchant_id,item_id) do update set paused_at=excluded.paused_at,reason=excluded.reason",
                [merchantId, itemId, new Date(pause.at), pause.reason],
              );
          },
        });
      } finally {
        let broken = false;
        try {
          await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [key]);
        } catch {
          broken = true;
        }
        // Retire a failed unlock's connection so nobody inherits the lock.
        client.release(broken);
      }
    },
  };
  return pauses;
}
