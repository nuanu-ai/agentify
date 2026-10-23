/**
 * The migrations that touch rows, run against rows. The rest of `pnpm test:db`
 * migrates an empty database, where a backfill touches nothing. Here a database
 * is brought up to the version before a migration, rows are written the way
 * that version wrote them, and the assertions are about what became of them:
 * nothing lost, nothing changing hands, nothing else touched.
 *
 * The files are applied as SQL, split on the migrator's own breakpoints,
 * because drizzle's migrator applies the whole folder and cannot stop part way.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEEDED_MERCHANT } from "../../app/merchants.js";
import { PaymentEdge } from "../../http/x402.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../testing/database.js";
import { countedIds, testConfig } from "../../testing/harness.js";
import { connect, type Database, PostgresStore } from "./store.js";

/**
 * A database of this file's own, not a schema: drizzle writes foreign keys as
 * `references "public"."merchants"`, so tables in any other schema would point
 * at a `public` this file does not control. Dropping and rebuilding at an older
 * version must also never happen under another suite's tables.
 */
const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/agentify_test_migration";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);

const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "..", "..", "drizzle");

/** One migration file, as the statements the migrator would run one by one. */
async function statementsOf(file: string): Promise<string[]> {
  const sql = await readFile(join(migrationsIn, file), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

if (databaseUrl === null) {
  describe.skip(`the migrations that touch rows ${noDatabaseHere(wanted)}`, () => {
    it("needs a database", () => undefined);
  });
} else {
  describe("the migration that gives every row an owner", () => {
    const url = databaseUrl;
    let pool: Pool;

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    /** The rows a gateway of the previous version would be holding. */
    const asItWasBefore = async (): Promise<void> => {
      await pool.query(
        `insert into cards (id, merchant_item_id, card, as_of, paused)
         values ($1, $2, $3, now(), true)`,
        ["itm_old", "sku-1", JSON.stringify({ merchant_item_id: "sku-1", title: "A room" })],
      );
      await pool.query(
        `insert into orders (id, state, open, item_id, merchant_item_id, record, created_at, updated_at)
         values ($1, $2, true, $3, $4, $5, now(), now())`,
        [
          "ord_old",
          "dispatched",
          "itm_old",
          "sku-1",
          JSON.stringify({
            order: { id: "ord_old", state: "dispatched" },
            itemId: "itm_old",
            merchantItemId: "sku-1",
          }),
        ],
      );
      await pool.query(
        `insert into receipts (order_id, receipt, updated_at) values ($1, $2, now())`,
        ["ord_old", JSON.stringify({ id: "rcp_old", order_id: "ord_old" })],
      );
    };

    beforeAll(async () => {
      pool = connect(url).pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      // Rebuilt before each test rather than after, so a run that died half way
      // through leaves the next one unharmed.
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      await run("0000_init.sql");
      await run("0001_payment_claims.sql");
      await run("0002_selling.sql");
    });

    it("gives every card, order and receipt to the one merchant they belong to", async () => {
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const owners = await pool.query<{ merchant_id: string }>(
        `select merchant_id from cards
         union all select merchant_id from orders
         union all select merchant_id from receipts`,
      );
      expect(owners.rows.map((row) => row.merchant_id)).toStrictEqual([
        SEEDED_MERCHANT.id,
        SEEDED_MERCHANT.id,
        SEEDED_MERCHANT.id,
      ]);
    });

    it("puts the merchant inside the order's document as well as in its column", async () => {
      // The column filters a merchant's list of orders; the document field
      // decides whose stream the order's next envelope goes on. With the column
      // and no field, a redelivery would silently reach nobody.
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ merchant_id: string; record: { merchantId?: string } }>(
        "select merchant_id, record from orders where id = 'ord_old'",
      );
      expect(rows[0]?.record.merchantId).toBe(SEEDED_MERCHANT.id);
      expect(rows[0]?.record.merchantId).toBe(rows[0]?.merchant_id);
    });

    it("loses nothing a card was carrying, including a pause", async () => {
      // A dropped pause silently puts stock the merchant took off sale back in
      // front of agents.
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ paused: boolean; merchant_item_id: string }>(
        "select paused, merchant_item_id from cards where id = 'itm_old'",
      );
      expect(rows[0]?.paused).toBe(true);
      expect(rows[0]?.merchant_item_id).toBe("sku-1");
    });

    it("does not put a merchant who had stopped selling back on sale", async () => {
      // The migration adopts the existing merchant row. Overwriting it would
      // bring a paused merchant back selling, and they would learn of it from
      // an order.
      await pool.query(
        "insert into merchants (id, selling, updated_at) values ($1, 'paused', now())",
        [SEEDED_MERCHANT.id],
      );
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ selling: string; name: string }>(
        "select selling, name from merchants",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.selling).toBe("paused");
      // The adopted row gets the name the column requires instead of failing.
      expect(rows[0]?.name).not.toBe("");
    });

    it("leaves one merchant and no orphans on a database that never sold anything", async () => {
      // A database whose selling switch was never pressed has no merchant row.
      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ id: string; selling: string }>(
        "select id, selling from merchants",
      );
      expect(rows).toStrictEqual([{ id: SEEDED_MERCHANT.id, selling: "open" }]);
    });

    it("lets two merchants use one identifier for two products afterwards", async () => {
      // Uniqueness is on the merchant and identifier together. On the identifier
      // alone, a second merchant publishing "sku-1" would edit the first one's card.
      await asItWasBefore();
      await run("0003_merchant_tenancy.sql");
      await pool.query(
        "insert into merchants (id, name, selling, created_at, updated_at) values ($1, 'Another', 'open', now(), now())",
        ["mch_other"],
      );

      await pool.query(
        `insert into cards (id, merchant_id, merchant_item_id, card, as_of)
         values ($1, $2, 'sku-1', $3, now())`,
        ["itm_new", "mch_other", JSON.stringify({ merchant_item_id: "sku-1" })],
      );

      const { rows } = await pool.query<{ count: string }>(
        "select count(*)::text as count from cards where merchant_item_id = 'sku-1'",
      );
      expect(rows[0]?.count).toBe("2");
      // One merchant still cannot have two cards under one identifier.
      await expect(
        pool.query(
          `insert into cards (id, merchant_id, merchant_item_id, card, as_of)
           values ($1, $2, 'sku-1', $3, now())`,
          ["itm_clash", "mch_other", JSON.stringify({ merchant_item_id: "sku-1" })],
        ),
      ).rejects.toThrow();
    });

    it("refuses a card, an order or a receipt that names no merchant", async () => {
      await run("0003_merchant_tenancy.sql");

      // Every other column is given, so the only thing refused is the merchant:
      // first missing, then one who does not exist.
      const rows = [
        {
          table: "cards",
          columns: "id, merchant_item_id, card, as_of",
          values: "'itm_x', 'sku-x', '{}', now()",
        },
        {
          table: "orders",
          columns: "id, state, open, item_id, merchant_item_id, record, created_at, updated_at",
          values: "'ord_x', 'created', true, 'itm_x', 'sku-x', '{}', now(), now()",
        },
        {
          table: "receipts",
          columns: "order_id, receipt, updated_at",
          values: "'ord_x', '{}', now()",
        },
      ];
      for (const { table, columns, values } of rows) {
        await expect(
          pool.query(`insert into ${table} (${columns}) values (${values})`),
          table,
        ).rejects.toMatchObject({ code: "23502", column: "merchant_id" });
        await expect(
          pool.query(
            `insert into ${table} (merchant_id, ${columns}) values ('mch_nobody', ${values})`,
          ),
          table,
        ).rejects.toMatchObject({
          code: "23503",
          constraint: `${table}_merchant_id_merchants_id_fk`,
        });
      }
    });
  });

  /**
   * The backfill of `payTo`, the address an order's payment was verified
   * against and its charge is sent to; a wallet moved mid-sale does not move
   * it. An order written without the key reads back as no address, and on a
   * deployment that settles for real its charge would be refused as "no
   * wallet" after the goods went out. Open, paid orders get their merchant's
   * current address; everything else is left exactly as it was found.
   */
  describe("the migration that carries the address a charge is sent to", () => {
    const url = databaseUrl;
    let pool: Pool;
    let db: Database;
    let store: PostgresStore;

    const PAID_AT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const WITH_WALLET = "mch_paid";
    const WITHOUT_WALLET = "mch_unpaid";

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    /** An order as the version before this migration wrote it: no `payTo` key. */
    const orderAsItWas = (
      id: string,
      merchantId: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      order: {
        id,
        state: "paid",
        price: { amount: "80.00", currency: "USD", asOf: 0 },
      },
      merchantId,
      itemId: "itm_1",
      merchantItemId: "sku-1",
      params: {},
      priceId: null,
      delivery: null,
      payment: "the authorisation the agent signed",
      paidBy: "0x1111111111111111111111111111111111111111",
      settlement: null,
      paymentWords: [],
      paymentWordsDropped: 0,
      openDeliveryId: null,
      ...extra,
    });

    const writeOrder = async (
      id: string,
      merchantId: string,
      { open = true, extra = {} }: { open?: boolean; extra?: Record<string, unknown> } = {},
    ): Promise<void> => {
      await pool.query(
        `insert into orders (id, state, open, merchant_id, item_id, merchant_item_id, record, created_at, updated_at)
         values ($1, 'paid', $2, $3, 'itm_1', 'sku-1', $4, now(), now())`,
        [id, open, merchantId, JSON.stringify(orderAsItWas(id, merchantId, extra))],
      );
    };

    /** The document as the gateway reads it back, through its own store. */
    const readBack = async (id: string): Promise<Record<string, unknown>> => {
      const record = await store.orderById(id);
      if (record === null) {
        throw new Error(`the order ${id} is not there`);
      }
      return record as unknown as Record<string, unknown>;
    };

    /**
     * Where a real settlement would send this order's charge, or the refusal it
     * would throw. It is the call the settle path makes with `record.payTo`, so
     * the assertion is about the money rather than the presence of a key.
     */
    const chargedTo = (payTo: unknown): string =>
      new PaymentEdge(
        testConfig({
          PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000009",
          PUBLIC_BASE_URL: "https://agentify.example",
        }),
      ).requirementsFor({ amount: "80.00", currency: "USD" }, "pay_1", payTo as string | null)
        .payTo;

    beforeAll(async () => {
      const connected = connect(url);
      pool = connected.pool;
      db = connected.db;
      store = PostgresStore.over(db, "eip155:84532", countedIds());
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
      ]) {
        await run(file);
      }
      await pool.query(
        `insert into merchants (id, name, selling, payout_wallet, created_at, updated_at)
         values ($1, 'A merchant who is paid somewhere', 'open', $2, now(), now()),
                ($3, 'A merchant who set no wallet', 'open', null, now(), now())`,
        [WITH_WALLET, PAID_AT, WITHOUT_WALLET],
      );
    });

    it("sends the charge on an order verified before the field existed to its merchant's wallet", async () => {
      await writeOrder("ord_open", WITH_WALLET);

      await run("0006_order_pay_to_backfill.sql");

      expect((await readBack("ord_open")).payTo).toBe(PAID_AT);
      expect(chargedTo((await readBack("ord_open")).payTo)).toBe(PAID_AT);
    });

    it("leaves the order of a merchant who has no wallet alone, because that sentence is true", async () => {
      // There is no address to give it, and the operator's own must never stand
      // in: that would send the merchant's takings to somebody else.
      await writeOrder("ord_nowhere", WITHOUT_WALLET);

      await run("0006_order_pay_to_backfill.sql");

      const untouched = await readBack("ord_nowhere");
      expect("payTo" in untouched).toBe(false);
      expect(() => chargedTo(untouched.payTo)).toThrow(/no wallet/);
    });

    it("touches no order that is closed or that nobody has paid for", async () => {
      // Rewriting a closed order's address would make the record disagree with
      // the chain it settled on. An unpaid order gets its address with the
      // payment, so writing one now would claim a wallet was checked when none was.
      await writeOrder("ord_closed", WITH_WALLET, { open: false });
      await writeOrder("ord_unpaid", WITH_WALLET, { extra: { payment: null } });

      await run("0006_order_pay_to_backfill.sql");

      expect("payTo" in (await readBack("ord_closed"))).toBe(false);
      expect("payTo" in (await readBack("ord_unpaid"))).toBe(false);
    });

    it("does not write over an address a payment was already verified against", async () => {
      // The address the payer signed for may differ from the merchant's current
      // wallet, and overwriting it would move a charge the buyer never
      // authorised. The sandbox writes null on purpose; only a missing key counts.
      const signedFor = "0x1111111111111111111111111111111111111111";
      await writeOrder("ord_signed", WITH_WALLET, { extra: { payTo: signedFor } });
      await writeOrder("ord_sandbox", WITH_WALLET, { extra: { payTo: null } });

      await run("0006_order_pay_to_backfill.sql");

      expect((await readBack("ord_signed")).payTo).toBe(signedFor);
      expect((await readBack("ord_sandbox")).payTo).toBeNull();
    });
  });

  /**
   * The migration that separates the keys a merchant issued from the one
   * registration made for their dashboard, found by its label and creation
   * instant. Matching nothing would silently leave the dashboard's key in the
   * list a merchant revokes keys from.
   */
  describe("the migration that says what each key was made for", () => {
    const url = databaseUrl;
    let pool: Pool;

    const MERCHANT = "mch_a";
    /** The label registration wrote on a merchant's first key. */
    const AS_REGISTRATION_WROTE_IT = "the key this merchant registered with";

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    /**
     * A key a merchant issued, written later than the merchant row. Registration
     * writes its key and the merchant in one transaction with one timestamp,
     * which is how the migration tells the two apart.
     */
    const writeKey = async (id: string, label: string): Promise<void> => {
      await pool.query(
        `insert into merchant_keys (id, merchant_id, label, digest, created_at)
         values ($1, $2, $3, $4, now())`,
        [id, MERCHANT, label, `digest-of-${id}`],
      );
    };

    /** The same, at the merchant's own creation, the way registering writes it. */
    const writeKeyAsRegistrationDoes = async (id: string, label: string): Promise<void> => {
      await pool.query(
        `insert into merchant_keys (id, merchant_id, label, digest, created_at)
         select $1, $2, $3, $4, m.created_at from merchants m where m.id = $2`,
        [id, MERCHANT, label, `digest-of-${id}`],
      );
    };

    const purposeOf = async (id: string): Promise<string> => {
      const { rows } = await pool.query<{ purpose: string }>(
        "select purpose from merchant_keys where id = $1",
        [id],
      );
      const found = rows[0];
      if (found === undefined) {
        throw new Error(`the key ${id} is not there`);
      }
      return found.purpose;
    };

    beforeAll(async () => {
      pool = connect(url).pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
        "0006_order_pay_to_backfill.sql",
      ]) {
        await run(file);
      }
      await pool.query(
        `insert into merchants (id, name, selling, created_at, updated_at)
         values ($1, 'A merchant', 'open', now(), now())`,
        [MERCHANT],
      );
    });

    it("hands the keys registration made to the dashboard and leaves the rest alone", async () => {
      // A merchant's own keys, the sandbox's included, stay theirs. The last one
      // carries registration's label but was issued later than the merchant row,
      // so matching on the label alone would take it.
      await writeKeyAsRegistrationDoes("mk_registered", AS_REGISTRATION_WROTE_IT);
      await writeKey("mk_worker", "the worker on the small box");
      await writeKey("mk_sandbox", "the sandbox key from the compose file");
      await writeKey("mk_same_words", AS_REGISTRATION_WROTE_IT);

      await run("0007_cabinet_keys.sql");

      expect(await purposeOf("mk_registered")).toBe("cabinet");
      expect(await purposeOf("mk_worker")).toBe("merchant_code");
      expect(await purposeOf("mk_sandbox")).toBe("merchant_code");
      expect(await purposeOf("mk_same_words")).toBe("merchant_code");
    });

    it("leaves a key alone that was written at its merchant's instant under another name", async () => {
      // Matching on the instant alone is not enough either: registration's key
      // also carries registration's label.
      await writeKeyAsRegistrationDoes("mk_same_instant", "the worker on the small box");

      await run("0007_cabinet_keys.sql");

      expect(await purposeOf("mk_same_instant")).toBe("merchant_code");
    });

    it("calls the keys registration made the dashboard's once the later rename runs, and leaves the rest alone", async () => {
      await writeKeyAsRegistrationDoes("mk_registered", AS_REGISTRATION_WROTE_IT);
      await writeKey("mk_worker", "the worker on the small box");

      for (const file of [
        "0007_cabinet_keys.sql",
        "0008_key_last_use.sql",
        "0009_live_approval.sql",
        "0010_pending_payout_wallet.sql",
        "0011_merchant_seller_site.sql",
        "0012_dashboard_keys.sql",
      ]) {
        await run(file);
      }

      expect(await purposeOf("mk_registered")).toBe("dashboard");
      expect(await purposeOf("mk_worker")).toBe("merchant_code");
    });

    it("refuses a key written afterwards that does not say what it is for", async () => {
      // The default is dropped after the backfill, so an insert that omits the
      // purpose fails instead of silently becoming one of the merchant's keys.
      await run("0007_cabinet_keys.sql");

      await expect(writeKey("mk_silent", "a key that says nothing")).rejects.toThrow(/purpose/);
    });
  });

  /**
   * The migration that adds a key's last use must backfill nothing. Copying the
   * creation instant would show a merchant a last-use date nothing stands
   * behind, and they might revoke a key on the strength of it. Existing keys
   * keep the same blank as a key that was never called.
   */
  describe("the migration that starts recording when a key was last used", () => {
    const url = databaseUrl;
    let pool: Pool;

    const MERCHANT = "mch_a";

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    const writeKey = async (id: string): Promise<void> => {
      await pool.query(
        `insert into merchant_keys (id, merchant_id, label, digest, purpose, created_at)
         values ($1, $2, $3, $4, 'merchant_code', now())`,
        [id, MERCHANT, `the key ${id}`, `digest-of-${id}`],
      );
    };

    const lastUseOf = async (id: string): Promise<Date | null> => {
      const { rows } = await pool.query<{ last_used_at: Date | null }>(
        "select last_used_at from merchant_keys where id = $1",
        [id],
      );
      const found = rows[0];
      if (found === undefined) {
        throw new Error(`the key ${id} is not there`);
      }
      return found.last_used_at;
    };

    beforeAll(async () => {
      pool = connect(url).pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
        "0006_order_pay_to_backfill.sql",
        "0007_cabinet_keys.sql",
      ]) {
        await run(file);
      }
      await pool.query(
        `insert into merchants (id, name, selling, created_at, updated_at)
         values ($1, 'A merchant', 'open', now(), now())`,
        [MERCHANT],
      );
    });

    it("guesses nothing about the keys it finds", async () => {
      await writeKey("mk_older_than_the_record");

      await run("0008_key_last_use.sql");

      expect(await lastUseOf("mk_older_than_the_record")).toBeNull();
    });
  });

  describe("the migration that adds live operator approval", () => {
    const url = databaseUrl;
    let pool: Pool;

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    beforeAll(async () => {
      pool = connect(url).pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
        "0006_order_pay_to_backfill.sql",
        "0007_cabinet_keys.sql",
        "0008_key_last_use.sql",
      ]) {
        await run(file);
      }
    });

    it("approves no existing or future merchant by inference", async () => {
      const updatedAt = new Date("2026-09-17T10:00:00.000Z");
      await pool.query(
        `insert into merchants
           (id, name, service_name, payout_wallet, selling, created_at, updated_at)
         values ($1, $2, $3, $4, 'paused', $5, $5)`,
        [
          "mch_existing",
          "An existing merchant",
          "Their shop",
          "0x0000000000000000000000000000000000000001",
          updatedAt,
        ],
      );

      await run("0009_live_approval.sql");

      const existing = await pool.query<{
        live_approved_at: Date | null;
        name: string;
        service_name: string | null;
        payout_wallet: string | null;
        selling: string;
        updated_at: Date;
      }>(
        `select live_approved_at, name, service_name, payout_wallet, selling, updated_at
         from merchants where id = 'mch_existing'`,
      );
      expect(existing.rows).toStrictEqual([
        {
          live_approved_at: null,
          name: "An existing merchant",
          service_name: "Their shop",
          payout_wallet: "0x0000000000000000000000000000000000000001",
          selling: "paused",
          updated_at: updatedAt,
        },
      ]);

      await pool.query(
        `insert into merchants (id, name, selling, created_at, updated_at)
         values ('mch_new', 'A new merchant', 'open', now(), now())`,
      );
      const future = await pool.query<{ live_approved_at: Date | null }>(
        "select live_approved_at from merchants where id = 'mch_new'",
      );
      expect(future.rows).toStrictEqual([{ live_approved_at: null }]);
    });
  });

  describe("the migration that lets a wallet change wait", () => {
    const url = databaseUrl;
    let pool: Pool;

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    beforeAll(async () => {
      pool = connect(url).pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
        "0006_order_pay_to_backfill.sql",
        "0007_cabinet_keys.sql",
        "0008_key_last_use.sql",
        "0009_live_approval.sql",
      ]) {
        await run(file);
      }
    });

    it("leaves every wallet paying where it paid, with nothing waiting", async () => {
      // Nothing was announced to these merchants, so nothing may be waiting: a
      // change found waiting after the migration is one nobody was told about.
      const updatedAt = new Date("2026-09-20T10:00:00.000Z");
      await pool.query(
        `insert into merchants (id, name, payout_wallet, selling, created_at, updated_at)
         values ('mch_paid', 'A paid merchant', $1, 'open', $2, $2)`,
        ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", updatedAt],
      );

      await run("0010_pending_payout_wallet.sql");

      const rows = await pool.query(
        `select payout_wallet, pending_payout_wallet, pending_payout_wallet_from, updated_at
         from merchants where id = 'mch_paid'`,
      );
      expect(rows.rows).toStrictEqual([
        {
          payout_wallet: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
          pending_payout_wallet: null,
          pending_payout_wallet_from: null,
          updated_at: updatedAt,
        },
      ]);
    });

    it("refuses half a waiting change, an address with no moment or a moment with none", async () => {
      // The store never writes half a change; the table refuses one written by
      // hand too.
      await run("0010_pending_payout_wallet.sql");

      await expect(
        pool.query(
          `insert into merchants (id, name, selling, created_at, updated_at, pending_payout_wallet)
           values ('mch_half', 'Half', 'open', now(), now(), '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359')`,
        ),
      ).rejects.toThrow(/pending_payout_wallet/);
      await expect(
        pool.query(
          `insert into merchants (id, name, selling, created_at, updated_at, pending_payout_wallet_from)
           values ('mch_half', 'Half', 'open', now(), now(), now())`,
        ),
      ).rejects.toThrow(/pending_payout_wallet/);
    });
  });

  describe("the migration that deletes the keys made for a dashboard", () => {
    // The dashboard calls the gateway in-process and holds no key, so a key made
    // for it serves only whoever holds a copy. Every one goes, including those
    // left by an interrupted renewal, and the purpose column with them.
    const url = databaseUrl;
    let pool: Pool;
    const MERCHANT = "mch_a";

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    const writeKey = async (id: string, purpose: string): Promise<void> => {
      await pool.query(
        `insert into merchant_keys (id, merchant_id, label, purpose, digest, created_at)
         values ($1, $2, $3, $4, $5, now())`,
        [id, MERCHANT, `the key ${id}`, purpose, `digest-of-${id}`],
      );
    };

    beforeAll(async () => {
      pool = connect(url).pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
        "0006_order_pay_to_backfill.sql",
        "0007_cabinet_keys.sql",
        "0008_key_last_use.sql",
        "0009_live_approval.sql",
        "0010_pending_payout_wallet.sql",
        "0011_merchant_seller_site.sql",
        "0012_dashboard_keys.sql",
      ]) {
        await run(file);
      }
      await pool.query(
        `insert into merchants (id, name, selling, created_at, updated_at)
         values ($1, 'A merchant', 'open', now(), now())`,
        [MERCHANT],
      );
    });

    it("deletes every key made for a dashboard and keeps every key a merchant issued", async () => {
      await writeKey("mk_on_the_row", "dashboard");
      await writeKey("mk_left_by_a_renewal", "dashboard");
      await writeKey("mk_worker", "merchant_code");

      await run("0013_delete_dashboard_keys.sql");

      const { rows } = await pool.query<{ id: string }>("select id from merchant_keys order by id");
      expect(rows.map((row) => row.id)).toStrictEqual(["mk_worker"]);
      const columns = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'merchant_keys'`,
      );
      expect(columns.rows.map((column) => column.column_name)).not.toContain("purpose");
    });
  });

  describe("the migration that records which integration sells", () => {
    // Rows already there carry no integration, so the shape of the merchant
    // item id decides: the import writes `woo_`, sixteen hex digits and a
    // product number, and nothing else does.
    const url = databaseUrl;
    let pool: Pool;

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    const writeMerchant = async (id: string): Promise<void> => {
      await pool.query(
        `insert into merchants (id, name, selling, created_at, updated_at)
         values ($1, $1, 'open', now(), now())`,
        [id],
      );
    };

    const writeCard = async (id: string, merchantId: string, merchantItemId: string) => {
      await pool.query(
        `insert into cards (id, merchant_id, merchant_item_id, card, as_of)
         values ($1, $2, $3, '{}', now())`,
        [id, merchantId, merchantItemId],
      );
    };

    const integrations = async (table: "cards" | "merchants") =>
      Object.fromEntries(
        (
          await pool.query<{ id: string; integration: string }>(
            `select id, integration from ${table} order by id`,
          )
        ).rows.map((row) => [row.id, row.integration]),
      );

    beforeAll(async () => {
      pool = connect(url).pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
        "0006_order_pay_to_backfill.sql",
        "0007_cabinet_keys.sql",
        "0008_key_last_use.sql",
        "0009_live_approval.sql",
        "0010_pending_payout_wallet.sql",
        "0011_merchant_seller_site.sql",
        "0012_dashboard_keys.sql",
        "0013_delete_dashboard_keys.sql",
      ]) {
        await run(file);
      }
    });

    it("puts imported cards and their merchants on the shop, and everything else on the code", async () => {
      await writeMerchant("mch_coded");
      await writeMerchant("mch_shop");
      await writeMerchant("mch_both");
      await writeMerchant("mch_none");
      await writeCard("item_coded", "mch_coded", "sku-1");
      await writeCard("item_shop", "mch_shop", "woo_0123456789abcdef_42");
      await writeCard("item_both_coded", "mch_both", "room-101");
      await writeCard("item_both_shop", "mch_both", "woo_fedcba9876543210_7");
      // Close to the shape and not it: an SDK merchant's own word for a product.
      await writeCard("item_lookalike", "mch_coded", "woo_mug_7");

      await run("0014_one_integration.sql");

      expect(await integrations("cards")).toStrictEqual({
        item_both_coded: "api",
        item_both_shop: "woocommerce",
        item_coded: "api",
        item_lookalike: "api",
        item_shop: "woocommerce",
      });
      // The pilot merchant migration 0003 writes is there too, with no card.
      expect(await integrations("merchants")).toStrictEqual({
        mch_both: "woocommerce",
        mch_coded: "api",
        mch_none: "api",
        mch_shop: "woocommerce",
        [SEEDED_MERCHANT.id]: "api",
      });
    });

    it("starts a new merchant on the code and refuses a card that says no integration", async () => {
      await run("0014_one_integration.sql");
      await writeMerchant("mch_new");

      expect(await integrations("merchants")).toStrictEqual({
        mch_new: "api",
        [SEEDED_MERCHANT.id]: "api",
      });
      await expect(writeCard("item_silent", "mch_new", "sku-1")).rejects.toThrow(/integration/);
      await expect(
        pool.query(
          `insert into cards (id, merchant_id, merchant_item_id, card, as_of, integration)
           values ('item_odd', 'mch_new', 'sku-2', '{}', now(), 'shopify')`,
        ),
      ).rejects.toThrow(/cards_integration_known/);
    });
  });

  describe("the migration that adds the registry of payout splits", () => {
    // The SQL cannot compute a split's address, which needs Keccak-256, so the
    // rows come from the gateway's start. The migration adds the table and
    // nothing else: every order keeps the address its payer signed for.
    const url = databaseUrl;
    let pool: Pool;

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    beforeAll(async () => {
      pool = connect(url).pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
        "0006_order_pay_to_backfill.sql",
        "0007_cabinet_keys.sql",
        "0008_key_last_use.sql",
        "0009_live_approval.sql",
        "0010_pending_payout_wallet.sql",
        "0011_merchant_seller_site.sql",
        "0012_dashboard_keys.sql",
        "0013_delete_dashboard_keys.sql",
        "0014_one_integration.sql",
      ]) {
        await run(file);
      }
    });

    it("writes no row and touches no merchant and no order", async () => {
      const wallet = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
      const waiting = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
      const at = new Date("2026-10-01T10:00:00.000Z");
      await pool.query(
        `insert into merchants (id, name, selling, created_at, updated_at, payout_wallet,
           pending_payout_wallet, pending_payout_wallet_from)
         values ('mch_paid', 'Paid', 'open', $1, $1, $2, null, null),
                ('mch_waiting', 'Waiting', 'open', $1, $1, $2, $3, $4),
                ('mch_unpaid', 'Unpaid', 'open', $1, $1, null, null, null)`,
        [at, wallet, waiting, new Date("2026-10-03T10:00:00.000Z")],
      );
      await pool.query(
        `insert into orders (id, state, open, merchant_id, item_id, merchant_item_id, record,
           created_at, updated_at)
         values ('ord_verified', 'dispatched', true, 'mch_paid', 'item_1', 'sku-1', $1, $2, $2)`,
        [JSON.stringify({ payment: "PAYMENT", payTo: wallet, merchantId: "mch_paid" }), at],
      );
      const merchantsBefore = (await pool.query("select * from merchants order by id")).rows;
      const ordersBefore = (await pool.query("select * from orders order by id")).rows;

      await run("0015_payout_splits.sql");

      expect((await pool.query("select * from payout_splits")).rows).toStrictEqual([]);
      expect((await pool.query("select * from merchants order by id")).rows).toStrictEqual(
        merchantsBefore,
      );
      expect((await pool.query("select * from orders order by id")).rows).toStrictEqual(
        ordersBefore,
      );
      const kept = await pool.query<{ pay_to: string }>(
        "select record ->> 'payTo' as pay_to from orders where id = 'ord_verified'",
      );
      expect(kept.rows[0]?.pay_to).toBe(wallet);
    });

    it("then keys a wallet's split in either spelling, keeping every row it finds", async () => {
      // A wallet may be stored in lower case while the rows name it
      // checksummed; a second row for the same wallet in another
      // spelling would be a second contract for one wallet.
      await run("0015_payout_splits.sql");
      const row = (address: string, merchant: string, wallet: string) =>
        pool.query(
          `insert into payout_splits values ($1, 'eip155:84532', $2, $3, '0xC', 999000, 1000,
             1000000, 0, '0x0000000000000000000000000000000000000000', '0xsalt', '0xF', now())`,
          [address, merchant, wallet],
        );
      const wallet = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
      await row("0x1111111111111111111111111111111111111111", "mch_paid", wallet);
      await row("0x2222222222222222222222222222222222222222", "mch_other", wallet);
      const before = (await pool.query("select * from payout_splits order by address")).rows;

      await run("0016_payout_split_wallet_any_spelling.sql");

      expect((await pool.query("select * from payout_splits order by address")).rows).toStrictEqual(
        before,
      );
      await expect(
        row("0x3333333333333333333333333333333333333333", "mch_paid", wallet.toLowerCase()),
      ).rejects.toMatchObject({ code: "23505", constraint: "payout_splits_wallet_unique" });
      await expect(
        row("0x4444444444444444444444444444444444444444", "mch_third", wallet.toLowerCase()),
      ).resolves.toBeDefined();
    });
  });

  describe("the migration that gives every order a payment reference", () => {
    // A payment names its order by a reference kept in the order's document.
    // Every order written before references existed is given one, so every
    // order has one, and every later charge for it carries one.
    const url = databaseUrl;
    let connected: ReturnType<typeof connect>;
    let pool: Pool;

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    beforeAll(async () => {
      connected = connect(url);
      pool = connected.pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
        "0006_order_pay_to_backfill.sql",
        "0007_cabinet_keys.sql",
        "0008_key_last_use.sql",
        "0009_live_approval.sql",
        "0010_pending_payout_wallet.sql",
        "0011_merchant_seller_site.sql",
        "0012_dashboard_keys.sql",
        "0013_delete_dashboard_keys.sql",
        "0014_one_integration.sql",
        "0015_payout_splits.sql",
        "0016_payout_split_wallet_any_spelling.sql",
        "0017_order_pay_to_index.sql",
      ]) {
        await run(file);
      }
      await pool.query(
        `insert into merchants (id, name, selling, created_at, updated_at)
         values ('mch_old', 'Old', 'open', now(), now())`,
      );
    });

    /** An order as the version before this migration wrote it, with no reference. */
    const writtenBefore = async (
      id: string,
      state: string,
      open: boolean,
      extra: Record<string, unknown> = {},
    ) => {
      const record = {
        order: { id, state },
        merchantId: "mch_old",
        itemId: "item_1",
        merchantItemId: "sku-1",
        payment: "PAYMENT",
        paidBy: "0x1111111111111111111111111111111111111111",
        ...extra,
      };
      await pool.query(
        `insert into orders (id, state, open, merchant_id, item_id, merchant_item_id, record,
           created_at, updated_at)
         values ($1, $2, $3, 'mch_old', 'item_1', 'sku-1', $4, now(), now())`,
        [id, state, open, JSON.stringify(record)],
      );
      return record;
    };

    const recordOf = async (id: string): Promise<Record<string, unknown>> => {
      const { rows } = await pool.query<{ record: Record<string, unknown> }>(
        "select record from orders where id = $1",
        [id],
      );
      return rows[0]?.record ?? {};
    };

    it("gives every order written before it a reference of its own, and changes nothing else", async () => {
      const unpaid = await writtenBefore("ord_unpaid", "delivered_unpaid", true);
      const done = await writtenBefore("ord_done", "delivered", false);

      await run("0018_order_payment_ref.sql");

      const [first, second] = [await recordOf("ord_unpaid"), await recordOf("ord_done")];
      expect(first.paymentRef).toMatch(/^pay_[0-9a-f]{32}$/);
      expect(second.paymentRef).toMatch(/^pay_[0-9a-f]{32}$/);
      expect(first.paymentRef).not.toBe(second.paymentRef);
      const { paymentRef: _first, ...firstRest } = first;
      const { paymentRef: _second, ...secondRest } = second;
      expect([firstRest, secondRest]).toStrictEqual([unpaid, done]);
    });

    it("leaves a reference already written alone, and gives one where the key holds null", async () => {
      await writtenBefore("ord_kept", "delivered", false, { paymentRef: "pay_kept" });
      await writtenBefore("ord_null", "delivered", false, { paymentRef: null });

      await run("0018_order_payment_ref.sql");

      expect((await recordOf("ord_kept")).paymentRef).toBe("pay_kept");
      expect((await recordOf("ord_null")).paymentRef).toMatch(/^pay_[0-9a-f]{32}$/);
    });

    it("finds a migrated order by the reference it was given", async () => {
      await writtenBefore("ord_unpaid", "delivered_unpaid", true);

      await run("0018_order_payment_ref.sql");

      const given = (await recordOf("ord_unpaid")).paymentRef;
      const store = PostgresStore.over(connected.db, "eip155:84532", countedIds());
      expect((await store.orderByPaymentRef(String(given)))?.order.id).toBe("ord_unpaid");
    });
  });

  describe("the migration retaining accepted payment authorizations", () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = connect(databaseUrl).pool;
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      const journal = JSON.parse(
        await readFile(join(migrationsIn, "meta", "_journal.json"), "utf8"),
      ) as { entries: { idx: number; tag: string }[] };
      for (const entry of journal.entries.filter((entry) => entry.idx < 19)) {
        for (const statement of await statementsOf(`${entry.tag}.sql`)) await pool.query(statement);
      }
    }, 60_000);
    afterAll(async () => {
      await pool.end();
    });

    it("keeps accepted claims while leaving unaccepted and orphan claims pruneable", async () => {
      await pool.query(
        "insert into merchants (id, name, selling, created_at, updated_at) values ('mch_recovery', 'Recovery', 'open', now(), now())",
      );
      for (const [id, payment] of [
        ["ord_accepted", "SAVED-AUTHORIZATION"],
        ["ord_unpaid", null],
      ]) {
        await pool.query(
          "insert into orders (id, state, open, merchant_id, item_id, merchant_item_id, record, created_at, updated_at) values ($1, 'rejected', false, 'mch_recovery', 'item_1', 'sku-1', $2, now(), now())",
          [id, JSON.stringify({ payment, paymentRef: `pay_for_${id}` })],
        );
      }
      await pool.query(
        "insert into payment_claims (fingerprint, order_id, claimed_at) values ('fp-accepted', 'ord_accepted', now()), ('fp-unpaid', 'ord_unpaid', now()), ('fp-orphan', 'ord_missing', now())",
      );
      for (const statement of await statementsOf("0019_payment_recovery.sql"))
        await pool.query(statement);
      expect(
        (await pool.query("select fingerprint, retained from payment_claims order by fingerprint"))
          .rows,
      ).toEqual([
        { fingerprint: "fp-accepted", retained: true },
        { fingerprint: "fp-orphan", retained: false },
        { fingerprint: "fp-unpaid", retained: false },
      ]);
      expect(
        (
          await pool.query(
            "select record ->> 'payment' as payment, record ->> 'paymentRef' as payment_ref from orders where id = 'ord_accepted'",
          )
        ).rows,
      ).toEqual([{ payment: "SAVED-AUTHORIZATION", payment_ref: "pay_for_ord_accepted" }]);
    });
  });

  describe("the migration recording fulfillment without claiming a refund", () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = connect(databaseUrl).pool;
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      await pool.query("drop schema if exists pgboss cascade");
      const journal = JSON.parse(
        await readFile(join(migrationsIn, "meta", "_journal.json"), "utf8"),
      ) as { entries: { idx: number; tag: string }[] };
      for (const entry of journal.entries.filter((entry) => entry.idx < 20)) {
        for (const statement of await statementsOf(`${entry.tag}.sql`)) await pool.query(statement);
      }
      await pool.query(
        "insert into merchants (id,name,selling,created_at,updated_at) values ('mch_closure','Closure','open',now(),now())",
      );
      await pool.query("create schema pgboss");
      await pool.query("create table pgboss.job (data jsonb not null)");
    }, 60_000);
    afterAll(async () => {
      await pool.query("drop schema if exists pgboss cascade");
      await pool.end();
    });

    it("preserves payment, private goods, merchant words and terminalness while replacing only status vocabulary", async () => {
      const originals = ["refund_due", "refunded", "delivered"].map((state) => ({
        order: {
          id: `ord_${state}`,
          state,
          payment: "settled",
          closure: { cause: "merchant_refused", code: "refund_due", message: "refunded" },
        },
        merchantId: "mch_closure",
        paymentRef: `pay_${state}`,
        payment: "ORIGINAL_AUTHORIZATION",
        paymentAttempt: {
          id: "pay_original",
          startedAt: 123,
          completion: { settled: true, transaction: "ORIGINAL_TRANSACTION" },
        },
        params: { refund_due: "refunded" },
        delivery: { code: "refund_due" },
      }));
      for (const original of originals) {
        await pool.query(
          "insert into orders (id,state,open,merchant_id,item_id,merchant_item_id,record,created_at,updated_at) values ($1,$2,$3,'mch_closure','itm_old','sku',$4,now(),now())",
          [
            original.order.id,
            original.order.state,
            original.order.state === "refund_due",
            JSON.stringify(original),
          ],
        );
        await pool.query(
          "insert into receipts (order_id,merchant_id,receipt,updated_at) values ($1,'mch_closure',$2,now())",
          [
            original.order.id,
            JSON.stringify({
              order_id: original.order.id,
              outcome: original.order.state,
              transaction: "ORIGINAL_TRANSACTION",
            }),
          ],
        );
      }
      await pool.query("insert into pgboss.job (data) values ($1),($2)", [
        JSON.stringify({
          kind: "order_event",
          payload: { type: "order.refund_due", message: "refund_due" },
        }),
        JSON.stringify({ kind: "order", payload: { params: { type: "order.refund_due" } } }),
      ]);
      for (const statement of await statementsOf("0020_merchant_fulfillment_closure.sql"))
        await pool.query(statement);
      const rows = (await pool.query("select state,open,record from orders order by id")).rows;
      for (const original of originals) {
        const row = rows.find((row) => row.record.order.id === original.order.id);
        const state =
          original.order.state === "refund_due"
            ? "unfulfilled"
            : original.order.state === "refunded"
              ? "fulfillment_closed"
              : "delivered";
        expect(row.state).toBe(state);
        expect(row.open).toBe(original.order.state === "refund_due");
        expect(row.record).toEqual({ ...original, order: { ...original.order, state } });
        expect(row.record.order).not.toHaveProperty("merchantClosure");
      }
      expect(
        (
          await pool.query(
            "select receipt ->> 'outcome' as outcome from receipts order by order_id",
          )
        ).rows,
      ).toEqual([
        { outcome: "delivered" },
        { outcome: "unfulfilled" },
        { outcome: "fulfillment_closed" },
      ]);
      expect(
        (await pool.query("select data from pgboss.job order by data ->> 'kind'")).rows,
      ).toEqual([
        { data: { kind: "order", payload: { params: { type: "order.refund_due" } } } },
        {
          data: {
            kind: "order_event",
            payload: { type: "order.unfulfilled", message: "refund_due" },
          },
        },
      ]);
    });
  });

  describe("the migration that dates each card's first publication", () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = connect(databaseUrl).pool;
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      const journal = JSON.parse(
        await readFile(join(migrationsIn, "meta", "_journal.json"), "utf8"),
      ) as { entries: { idx: number; tag: string }[] };
      for (const entry of journal.entries.filter((entry) => entry.idx < 21)) {
        for (const statement of await statementsOf(`${entry.tag}.sql`)) await pool.query(statement);
      }
      await pool.query(
        "insert into merchants (id,name,selling,created_at,updated_at) values ('mch_dated','Dated','open',now(),now())",
      );
    }, 60_000);
    afterAll(async () => {
      await pool.end();
    });

    it("dates every card already published by the moment it holds, a card written afterwards without that date by the moment it is written, and refuses one whose date is null", async () => {
      const first = new Date("2026-10-01T08:00:00.000Z");
      const second = new Date("2026-10-02T08:00:00.000Z");
      await pool.query(
        `insert into cards (id, merchant_id, merchant_item_id, card, as_of, integration)
         values ('item_first', 'mch_dated', 'sku-1', '{}', $1, 'api'),
                ('item_second', 'mch_dated', 'sku-2', '{}', $2, 'woocommerce')`,
        [first, second],
      );

      for (const statement of await statementsOf("0021_card_first_published.sql")) {
        await pool.query(statement);
      }

      expect(
        (await pool.query("select id, as_of, published_at from cards order by id")).rows,
      ).toStrictEqual([
        { id: "item_first", as_of: first, published_at: first },
        { id: "item_second", as_of: second, published_at: second },
      ]);
      const [undated] = (
        await pool.query<{ published_at: Date; written_at: Date }>(
          `insert into cards (id, merchant_id, merchant_item_id, card, as_of, integration)
           values ('item_undated', 'mch_dated', 'sku-3', '{}', now(), 'api')
           returning published_at, now() as written_at`,
        )
      ).rows;
      expect(undated?.published_at).toStrictEqual(undated?.written_at);
      await expect(
        pool.query(
          `insert into cards
             (id, merchant_id, merchant_item_id, card, as_of, published_at, integration)
           values ('item_null', 'mch_dated', 'sku-4', '{}', now(), null, 'api')`,
        ),
      ).rejects.toMatchObject({ code: "23502" });
    });
  });

  describe("the migration that drops the confirmation step from stored orders", () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = connect(databaseUrl).pool;
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      const journal = JSON.parse(
        await readFile(join(migrationsIn, "meta", "_journal.json"), "utf8"),
      ) as { entries: { idx: number; tag: string }[] };
      for (const entry of journal.entries.filter((entry) => entry.idx < 23)) {
        for (const statement of await statementsOf(`${entry.tag}.sql`)) await pool.query(statement);
      }
      await pool.query(
        "insert into merchants (id,name,selling,created_at,updated_at) values ('mch_plain','Plain','open',now(),now())",
      );
    }, 60_000);
    afterAll(async () => {
      await pool.end();
    });

    it("takes the confirmation's flag, instants and deadlines out of every order and leaves the rest as it was", async () => {
      const kept = {
        order: {
          id: "ord_kept",
          state: "delivered",
          mode: { settle: "on_purchase", parcel: true },
          policy: {
            deadlines: { quoteTtlMs: 30_000, asyncFulfillmentMs: 86_400_000 },
            redelivery: { maxAttempts: 5 },
          },
          timestamps: { createdAt: 1, paidAt: 2 },
        },
        merchantId: "mch_plain",
        params: { needsConfirmation: true },
      };
      const written = {
        ...kept,
        order: {
          ...kept.order,
          id: "ord_written",
          mode: { needsConfirmation: false, ...kept.order.mode },
          policy: {
            ...kept.order.policy,
            deadlines: {
              ...kept.order.policy.deadlines,
              paymentAfterConfirmationMs: 300_000,
              confirmationResponseMs: 3_600_000,
            },
          },
          timestamps: {
            ...kept.order.timestamps,
            confirmationRequestedAt: null,
            confirmedAt: null,
          },
        },
      };
      for (const record of [kept, written]) {
        await pool.query(
          "insert into orders (id,state,open,merchant_id,item_id,merchant_item_id,record,created_at,updated_at) values ($1,'delivered',false,'mch_plain','itm_plain','sku',$2,now(),now())",
          [record.order.id, JSON.stringify(record)],
        );
      }

      for (const statement of await statementsOf("0023_order_drops_confirmation.sql")) {
        await pool.query(statement);
      }

      const rows = (await pool.query("select id, record from orders order by id")).rows;
      expect(rows).toStrictEqual([
        { id: "ord_kept", record: kept },
        { id: "ord_written", record: { ...kept, order: { ...kept.order, id: "ord_written" } } },
      ]);
    });
  });

  describe("the migration that marks the attempts that lapsed unpaid", () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = connect(databaseUrl).pool;
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      const journal = JSON.parse(
        await readFile(join(migrationsIn, "meta", "_journal.json"), "utf8"),
      ) as { entries: { idx: number; tag: string }[] };
      for (const entry of journal.entries.filter((entry) => entry.idx < 27)) {
        for (const statement of await statementsOf(`${entry.tag}.sql`)) await pool.query(statement);
      }
      await pool.query(
        "insert into merchants (id,name,selling,created_at,updated_at) values ('mch_lapsed','Lapsed','open',now(),now())",
      );
    }, 60_000);
    afterAll(async () => {
      await pool.end();
    });

    it("marks an order that ended rejected or expired with nothing charged or held, and no other", async () => {
      const ended = (id: string, state: string, order: object = {}, record: object = {}) => ({
        order: {
          id,
          state,
          payment: "none",
          heldFulfillment: false,
          ...order,
        },
        merchantId: "mch_lapsed",
        paymentRef: `pay_${id}`,
        payment: null,
        paidBy: null,
        delivery: null,
        ...record,
      });
      const rows = [
        ended("ord_refused", "rejected"),
        ended("ord_lapsed", "expired"),
        ended("ord_goods_held", "expired", { heldFulfillment: true }),
        ended("ord_charge_failed", "rejected", { payment: "settle_failed" }),
        ended("ord_presented", "expired", {}, { payment: "PAYMENT" }),
        ended("ord_attempted", "expired", {}, { paymentAttempt: { id: "att_1" } }),
        ended("ord_delivered", "delivered", { payment: "settled" }),
        ended("ord_waiting", "quoted"),
      ];
      for (const row of rows) {
        await pool.query(
          "insert into orders (id,state,open,merchant_id,item_id,merchant_item_id,record,created_at,updated_at) values ($1,$2,false,'mch_lapsed','itm_old','sku',$3,now(),now())",
          [row.order.id, row.order.state, JSON.stringify(row)],
        );
      }

      for (const statement of await statementsOf("0027_order_lapsed_attempts.sql")) {
        await pool.query(statement);
      }

      expect(
        (await pool.query("select id from orders where lapsed order by id")).rows,
      ).toStrictEqual([{ id: "ord_lapsed" }, { id: "ord_refused" }]);
      expect((await pool.query("select count(*)::int as count from orders")).rows).toStrictEqual([
        { count: rows.length },
      ]);
    });
  });

  describe("the migration that gives every order a buyer's key", () => {
    let connected: ReturnType<typeof connect>;
    let pool: Pool;
    beforeAll(async () => {
      connected = connect(databaseUrl);
      pool = connected.pool;
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      const journal = JSON.parse(
        await readFile(join(migrationsIn, "meta", "_journal.json"), "utf8"),
      ) as { entries: { idx: number; tag: string }[] };
      for (const entry of journal.entries.filter((entry) => entry.idx < 28)) {
        for (const statement of await statementsOf(`${entry.tag}.sql`)) await pool.query(statement);
      }
      await pool.query(
        "insert into merchants (id,name,selling,created_at,updated_at) values ('mch_keyless','Keyless','open',now(),now())",
      );
    }, 60_000);
    afterAll(async () => {
      await pool.end();
    });

    it("gives every order written before it a key of its own that opens it, and changes nothing else", async () => {
      // Nobody holds a key for these orders: their buyers were handed
      // addresses built from the identifier, which opens nothing any more.
      const keyless = (id: string, state: string) => ({
        order: { id, state, payment: "settled" },
        merchantId: "mch_keyless",
        itemId: "itm_old",
        merchantItemId: "sku",
        paymentRef: `pay_${id}`,
        payment: null,
        paidBy: "0x1111111111111111111111111111111111111111",
        delivery: { access_code: "SESAME" },
      });
      const rows = [keyless("ord_delivered", "delivered"), keyless("ord_waiting", "dispatched")];
      for (const row of rows) {
        await pool.query(
          "insert into orders (id,state,open,merchant_id,item_id,merchant_item_id,record,created_at,updated_at) values ($1,$2,false,'mch_keyless','itm_old','sku',$3,now(),now())",
          [row.order.id, row.order.state, JSON.stringify(row)],
        );
      }

      for (const statement of await statementsOf("0028_order_buyer_key.sql")) {
        await pool.query(statement);
      }

      const records = (
        await pool.query<{ record: Record<string, unknown> }>(
          "select record from orders order by id",
        )
      ).rows.map((row) => row.record);
      const keys = records.map((record) => record.buyerKey);
      for (const key of keys) expect(key).toMatch(/^bk_[0-9a-f]{32}$/);
      expect(new Set(keys).size).toBe(rows.length);
      expect(records.map(({ buyerKey: _key, ...rest }) => rest)).toStrictEqual([rows[0], rows[1]]);
      const store = PostgresStore.over(connected.db, "eip155:84532", countedIds());
      expect((await store.orderByBuyerKey(String(keys[0])))?.order.id).toBe("ord_delivered");
      expect(await store.orderByBuyerKey("ord_delivered")).toBeNull();
    });
  });
}
