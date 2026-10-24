/**
 * The journal as the dashboard's own administrative actions write it: ending a
 * person's sessions, granting or removing the operator flag, forgetting an
 * account. Such an action opens one transaction around its own change and the
 * row that records it, so both commit or neither does. A gateway action takes
 * its row into the store's transaction instead, through the store write's last
 * argument, and a refused press is written by the store on its own.
 *
 * In memory, where tests run without a database, the change is given no
 * transaction and the row is written after it returns; nothing but the code
 * itself can fail between the two there.
 */

import type { Store } from "@agentify/gateway";
import { type JournalEntry, journalAlong } from "@agentify/gateway/journal";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

/** A transaction on the dashboard's pool, on which the change and its row are written. */
export type JournalTransaction = Parameters<
  Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

export interface DashboardJournal {
  /**
   * Runs `change` and writes the row `rowOf` makes of what it returned, in one
   * transaction; null from `rowOf` writes none. A throw from either, or a row
   * the journal refuses, rolls the change back. `change` is handed the
   * transaction, or null in memory.
   */
  along<R>(
    change: (tx: JournalTransaction | null) => Promise<R>,
    rowOf: (result: R) => JournalEntry | null,
  ): Promise<R>;
}

export function postgresJournal(pool: Pool): DashboardJournal {
  const db = drizzle(pool);
  return {
    async along(change, rowOf) {
      return await db.transaction(async (tx) => {
        const result = await change(tx);
        const row = rowOf(result);
        if (row !== null) await journalAlong(tx, row);
        return result;
      });
    },
  };
}

/** For tests: the row goes into the gateway's memory store, where the workspace reads it. */
export function memoryJournal(store: Pick<Store, "recordJournal">): DashboardJournal {
  return {
    async along(change, rowOf) {
      const result = await change(null);
      const row = rowOf(result);
      if (row !== null) await store.recordJournal(row);
      return result;
    },
  };
}
