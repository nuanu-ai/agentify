/**
 * How every read of the operator's reader runs on Postgres: inside a
 * transaction opened read only, so the database refuses any write a read might
 * attempt, with a statement time of its own, so a slow page is cut off rather
 * than holding connections the money path needs. The handle a read is given
 * can select and run raw SQL; whatever it tries, the transaction can only read.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/** How long one statement of an operator's read may run before the database cancels it. */
export const OPERATOR_STATEMENT_MS = 5_000;

type Transaction = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

/** What a read is handed: a read-only transaction's ways of reading. */
export type ReadOnlyTransaction = Pick<
  Transaction,
  "select" | "selectDistinct" | "$count" | "execute"
>;

/** Runs one read of the operator's reader. */
export type ReadOnly = <T>(read: (tx: ReadOnlyTransaction) => Promise<T>) => Promise<T>;

export function readOnlyOn(
  db: NodePgDatabase,
  statementMs: number = OPERATOR_STATEMENT_MS,
): ReadOnly {
  if (!Number.isInteger(statementMs) || statementMs <= 0) {
    throw new Error("an operator's read needs a statement time of a whole number of milliseconds");
  }
  return async (read) =>
    await db.transaction(
      async (tx) => {
        // Local to the transaction (the `true`), so the bound never stays on
        // the pooled connection for whoever borrows it next. Set by a query
        // rather than a SET command on purpose: Postgres lets a transaction's
        // mode change until its first query, so a read that began with
        // `set transaction read write` would otherwise be writable.
        await tx.execute(sql`select set_config('statement_timeout', ${String(statementMs)}, true)`);
        return await read(tx);
      },
      // Repeatable read, so a page's count and the rows it counts are read at
      // one moment and cannot say "1–50 of 49".
      { accessMode: "read only", isolationLevel: "repeatable read" },
    );
}
