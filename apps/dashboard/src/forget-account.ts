/**
 * Removes one address's dashboard account and the merchant it names in one
 * transaction, so the address next signs in as a newcomer. The account row
 * takes its sessions, credentials, WooCommerce rows and reports to the ad
 * tracker by cascade; the merchant's cards are deleted first, because the
 * gateway's schema does not let a merchant with cards go; the link-send
 * counters are cleared so the next link can be asked for at once.
 *
 * It refuses before writing anything when the merchant has an order or a
 * receipt (money history is never deleted to make a test repeatable) or when
 * another account names the same merchant. A one-time link still in the mailbox
 * is left: it can only open the address as a newcomer. Whether this may run at
 * all is decided in `forget.ts`, which refuses every non-test payment network.
 */

import type { Pool, PoolClient } from "pg";
import { emailAs, rateKey } from "./identity.js";
import { printable } from "./printable.js";

export interface ForgetTerminal {
  readonly say: (line: string) => void;
}

type Outcome =
  | { readonly kind: "no-account" }
  | {
      readonly kind: "money-history";
      readonly merchantId: string;
      readonly orders: number;
      readonly receipts: number;
    }
  | { readonly kind: "shared-merchant"; readonly merchantId: string; readonly others: number }
  | {
      readonly kind: "forgotten";
      readonly merchant: {
        readonly id: string;
        readonly present: boolean;
        readonly cards: number;
      } | null;
      readonly shop: string | null;
      readonly operator: boolean;
    };

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function only<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("dashboard_forget_count_missing");
  return row;
}

async function forgetIn(client: PoolClient, email: string, authSecret: string): Promise<Outcome> {
  // The lock a link request and a sign-in for this address take first, so
  // neither lands between the reads below and the deletes after them.
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `dashboard-email:${email}`,
  ]);
  const account = (
    await client.query<{ id: string; merchantId: string | null; operator: boolean }>(
      `select id, merchant_id as "merchantId", operator
         from dashboard_accounts where email = $1 for update`,
      [email],
    )
  ).rows[0];
  if (account === undefined) return { kind: "no-account" };

  let merchant: Extract<Outcome, { kind: "forgotten" }>["merchant"] = null;
  if (account.merchantId !== null) {
    const id = account.merchantId;
    // Locked, so an order or a card written for this merchant meanwhile waits
    // rather than slipping in after the count.
    const present =
      (await client.query("select id from merchants where id = $1 for update", [id])).rowCount ===
      1;
    const history = only(
      (
        await client.query<{ orders: number; receipts: number }>(
          `select (select count(*) from orders where merchant_id = $1)::int as orders,
                  (select count(*) from receipts where merchant_id = $1)::int as receipts`,
          [id],
        )
      ).rows,
    );
    if (history.orders > 0 || history.receipts > 0) {
      return { kind: "money-history", merchantId: id, ...history };
    }
    const others = only(
      (
        await client.query<{ count: number }>(
          `select count(*)::int as count
             from dashboard_accounts where merchant_id = $1 and id <> $2`,
          [id, account.id],
        )
      ).rows,
    ).count;
    if (others > 0) return { kind: "shared-merchant", merchantId: id, others };

    const cards = (await client.query("delete from cards where merchant_id = $1", [id])).rowCount;
    await client.query("delete from merchants where id = $1", [id]);
    merchant = { id, present, cards: cards ?? 0 };
  }

  const shop =
    (
      await client.query<{ shopUrl: string }>(
        `select shop_url as "shopUrl" from dashboard_woo_shops where account_id = $1`,
        [account.id],
      )
    ).rows[0]?.shopUrl ?? null;
  await client.query("delete from dashboard_accounts where id = $1", [account.id]);

  // Sign-in sends are keyed with the dashboard's secret and report-link sends
  // with the digest key kept in the database; a database that never sent a
  // report link has no digest key and no such rows.
  const digestKeys = (
    await client.query<{ digestKey: string }>(
      `select digest_key as "digestKey" from dashboard_report_identity_secrets`,
    )
  ).rows.map((row) => row.digestKey);
  await client.query("delete from dashboard_link_sends where email_hash = any($1)", [
    [authSecret, ...digestKeys].map((secret) => rateKey(secret, email)),
  ]);

  return { kind: "forgotten", merchant, shop, operator: account.operator };
}

/**
 * A failure during the commit is the one moment this side cannot know which way
 * it went, and it is said so; running the command again is safe, because it
 * either finishes or finds no account.
 */
export async function runForget(
  pool: Pool,
  rawEmail: string,
  authSecret: string,
  terminal: ForgetTerminal,
): Promise<number> {
  const say = (line: string): void => terminal.say(printable(line));
  const email = emailAs(rawEmail);

  let outcome: Outcome;
  let committing = false;
  let client: PoolClient | undefined;
  let failed = false;
  try {
    client = await pool.connect();
    await client.query("begin");
    outcome = await forgetIn(client, email, authSecret);
    committing = outcome.kind === "forgotten";
    await client.query(committing ? "commit" : "rollback");
  } catch {
    failed = true;
    await client?.query("rollback").catch(() => undefined);
    say(
      committing
        ? "The TEST forget's outcome is unknown: the database did not confirm the commit." +
            " Run the same command again; it finishes the work or says the address has no account."
        : "The TEST forget could not finish, and removed nothing.",
    );
    return 1;
  } finally {
    client?.release(failed);
  }

  switch (outcome.kind) {
    case "no-account":
      say(`TEST forget refused: no account has the address ${email}. Nothing was removed.`);
      return 1;
    case "money-history":
      say(
        `TEST forget refused: merchant ${outcome.merchantId} has ${plural(outcome.orders, "order")}` +
          ` and ${plural(outcome.receipts, "receipt")}, and money history is not deleted.` +
          " Nothing was removed.",
      );
      return 1;
    case "shared-merchant":
      say(
        `TEST forget refused: merchant ${outcome.merchantId} is also named by` +
          ` ${plural(outcome.others, "other account")}, which would be left without it.` +
          " Nothing was removed.",
      );
      return 1;
    case "forgotten": {
      const { merchant, shop } = outcome;
      say("TEST account forgotten");
      say(`Account: ${email}, removed with its sessions`);
      say(
        merchant === null
          ? "Merchant: none"
          : merchant.present
            ? `Merchant: ${merchant.id}, removed with its keys`
            : `Merchant: ${merchant.id}, already absent from the gateway`,
      );
      say(`Cards removed: ${merchant?.cards ?? 0}`);
      say(
        shop === null
          ? "WooCommerce connection: none"
          : `WooCommerce connection: dropped for ${shop}; its key stays valid in that shop` +
              " until it is revoked in the shop's WooCommerce settings",
      );
      if (outcome.operator) {
        say(
          "Operator flag: removed with the account; after the next sign-in," +
            ` \`pnpm --filter @agentify/dashboard account operator ${email}\` sets it again`,
        );
      }
      say("The address can ask for a sign-in link now, and signs in as a newcomer.");
      return 0;
    }
  }
}
