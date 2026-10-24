/**
 * The journal as the dashboard's own administrative actions write it: ending a
 * person's sessions, granting or removing the operator flag, forgetting an
 * account. Such an action is handed its press, as a store write is, and the
 * change and the row that records it commit together or neither does. A
 * gateway action takes its press into the store write's own transaction
 * instead, and a refused press is written by the store on its own.
 */

import type { Store } from "@agentify/gateway";
import {
  checkedJournalEntry,
  type JournalPress,
  journalAlong,
  settledPress,
} from "@agentify/gateway/journal";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

/** A transaction on the dashboard's pool, on which the change and its row are written. */
export type JournalTransaction = Parameters<
  Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

/**
 * What a change answers: what it returns to its caller, and whether it changed
 * anything, which settles its row as done or unchanged; null where there was
 * nothing to act on (no such account), which writes no row, and the press is
 * recorded as refused by its caller.
 */
export type Settled<R> = Readonly<{ result: R; changed: boolean | null }>;

export interface DashboardJournal {
  /**
   * Runs `change` and writes the row `press` settles as, in one transaction. A
   * press the journal refuses refuses the change before it runs; a change that
   * throws writes no row. On Postgres `change` is handed the transaction and
   * must run every statement of its change on that `tx`, or the change commits
   * on its own whatever becomes of the row. In memory it is handed null.
   */
  along<R>(
    press: JournalPress,
    change: (tx: JournalTransaction | null) => Promise<Settled<R>>,
  ): Promise<R>;
}

/** Throws on a press the journal would refuse, whichever way the change settles it. */
const checkedPress = (press: JournalPress): void => {
  checkedJournalEntry(settledPress(press, true));
};

export function postgresJournal(pool: Pool): DashboardJournal {
  const db = drizzle(pool);
  return {
    async along(press, change) {
      checkedPress(press);
      return await db.transaction(async (tx) => {
        const { result, changed } = await change(tx);
        if (changed !== null) await journalAlong(tx, settledPress(press, changed));
        return result;
      });
    },
  };
}

/**
 * For tests: the row goes into the gateway's memory store, where the workspace
 * reads it. The press is checked before the change runs, as the transaction's
 * rollback refuses both on Postgres.
 */
export function memoryJournal(store: Pick<Store, "recordJournal">): DashboardJournal {
  return {
    async along(press, change) {
      checkedPress(press);
      const { result, changed } = await change(null);
      if (changed !== null) await store.recordJournal(settledPress(press, changed));
      return result;
    },
  };
}
