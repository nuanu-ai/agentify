/**
 * What `pnpm forget <email>` does on the test deployment: it removes one
 * address's cabinet account and the merchant that account names, in one
 * transaction, so that the address signs in next time as a newcomer.
 *
 * The account row takes with it, through the cascades the cabinet's schema
 * declares, the address's sessions, its component credentials and every
 * WooCommerce row that hangs off it: the connected shop, a Connect still
 * waiting, the quotes and the shop orders. The operator flag is a column on
 * that row and goes with it. The merchant row takes its keys by cascade, and
 * its payout wallet, with any change waiting on it, is on the row itself; its
 * cards are deleted first, because the gateway's schema does not let a
 * merchant with cards go. The link sends the cabinet counts against an
 * address, for its own sign-in and for the report links it sends on the
 * scanner's behalf, are cleared under the keys it writes them with, so the next
 * link can be asked for at once. The scanner's own limit on registrations per
 * address is the scanner's, and this does not touch it.
 *
 * Two things refuse it, and both refuse before anything is written. A merchant
 * with an order or a receipt has money history, and money history is not
 * deleted to make a test repeatable. A merchant another account also names is
 * that account's merchant too, and removing it would leave that account bound
 * to nothing.
 *
 * Some things are left where they are on purpose. A one-time link still in the
 * mailbox stays: it can only open the address as a newcomer, and it runs out
 * within the hour. The scanner's reports belong to the address rather than to
 * the account, and the scanner has its own deletion for them. The merchant's
 * queue on the gateway carries envelopes for orders only, and a merchant that
 * gets this far has none.
 *
 * Whether this may run at all is not decided here: `forget.ts` refuses every
 * deployment whose payment network is not a test network before it opens a
 * connection.
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
  if (row === undefined) throw new Error("cabinet_forget_count_missing");
  return row;
}

async function forgetIn(client: PoolClient, email: string, authSecret: string): Promise<Outcome> {
  // The lock a link request and a sign-in for this address take first, so
  // neither lands between the reads below and the deletes after them.
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `cabinet-email:${email}`,
  ]);
  const account = (
    await client.query<{ id: string; merchantId: string | null; operator: boolean }>(
      `select id, merchant_id as "merchantId", operator
         from cabinet_accounts where email = $1 for update`,
      [email],
    )
  ).rows[0];
  if (account === undefined) return { kind: "no-account" };

  let merchant: Extract<Outcome, { kind: "forgotten" }>["merchant"] = null;
  if (account.merchantId !== null) {
    const id = account.merchantId;
    // Locked, so an order or a card written for this merchant while this runs
    // waits for the answer rather than slipping in after the count.
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
             from cabinet_accounts where merchant_id = $1 and id <> $2`,
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
        `select shop_url as "shopUrl" from cabinet_woo_shops where account_id = $1`,
        [account.id],
      )
    ).rows[0]?.shopUrl ?? null;
  await client.query("delete from cabinet_accounts where id = $1", [account.id]);

  // The sign-in door keys its sends with the cabinet's own secret and the
  // report door with the digest key it keeps in the database; a database whose
  // report door never sent anything has no digest key and no such rows.
  const digestKeys = (
    await client.query<{ digestKey: string }>(
      `select digest_key as "digestKey" from cabinet_report_identity_secrets`,
    )
  ).rows.map((row) => row.digestKey);
  await client.query("delete from cabinet_link_sends where email_hash = any($1)", [
    [authSecret, ...digestKeys].map((secret) => rateKey(secret, email)),
  ]);

  return { kind: "forgotten", merchant, shop, operator: account.operator };
}

/**
 * Forgets the account at this address and says what went, or why nothing did.
 *
 * A failure before the commit is a transaction the database rolled back, and
 * it is said as that. A failure during the commit is the one moment this side
 * cannot know which way it went, and it is said as that too: the command is
 * safe to run again, because it either finishes or finds no account.
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
            ` \`pnpm --filter @agentify/cabinet account operator ${email}\` sets it again`,
        );
      }
      say("The address can ask for a sign-in link now, and signs in as a newcomer.");
      return 0;
    }
  }
}
