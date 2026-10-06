/**
 * The cabinet side of production approval identity.
 *
 * Email stays here. The gateway receives only the merchant identifier already
 * bound to exactly one cabinet account, and the merchant key is reduced to a
 * presence bit inside the query so this operator can never print or use it as
 * authority.
 */

import type { Pool } from "pg";
import type { ApprovalDirectory, ApprovalDirectoryEntry } from "./approval-command.js";
import { emailAs } from "./identity.js";

interface AccountBindingRow {
  readonly merchantId: string | null;
  readonly hasMerchantKey: boolean;
}

export class PostgresApprovalDirectory implements ApprovalDirectory {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async resolve(rawEmail: string): Promise<readonly ApprovalDirectoryEntry[]> {
    const email = emailAs(rawEmail);
    const found = await this.#pool.query<AccountBindingRow>(
      `select merchant_id as "merchantId",
              merchant_key is not null and merchant_key <> '' as "hasMerchantKey"
         from cabinet_accounts
        where lower(btrim(email)) = $1
        limit 2`,
      [email],
    );

    return found.rows.map((row) => {
      const hasMerchantId = row.merchantId !== null && row.merchantId !== "";
      if (hasMerchantId && row.hasMerchantKey) {
        return { email, binding: "bound", merchantId: row.merchantId };
      }
      if (!hasMerchantId && !row.hasMerchantKey) {
        return { email, binding: "unbound" };
      }
      return { email, binding: "partial" };
    });
  }
}
