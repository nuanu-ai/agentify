/**
 * The email address stays on the dashboard side: the gateway receives only the
 * merchant identifier bound to exactly one dashboard account.
 */

import type { Pool } from "pg";
import type { ApprovalDirectory, ApprovalDirectoryEntry } from "./approval-command.js";
import { emailAs } from "./identity.js";

interface AccountBindingRow {
  readonly merchantId: string | null;
}

export class PostgresApprovalDirectory implements ApprovalDirectory {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async resolve(rawEmail: string): Promise<readonly ApprovalDirectoryEntry[]> {
    const email = emailAs(rawEmail);
    const found = await this.#pool.query<AccountBindingRow>(
      `select merchant_id as "merchantId"
         from dashboard_accounts
        where lower(btrim(email)) = $1
        limit 2`,
      [email],
    );

    return found.rows.map((row) =>
      row.merchantId !== null && row.merchantId !== ""
        ? { email, binding: "bound", merchantId: row.merchantId }
        : { email, binding: "unbound" },
    );
  }
}
