/**
 * Both stores, memory and Postgres, are held to this one list, because the
 * properties that matter are the easiest to have in one and not the other: a
 * token that works once, and a sale placed in somebody's shop once.
 */

import { describe, expect, it } from "vitest";
import type { WooOrderFacts, WooPermission, WooShops } from "../woo-shops.js";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const LATER = new Date("2026-09-14T12:10:00.000Z");
const MUCH_LATER = new Date("2026-09-14T13:00:00.000Z");
const FACTS: WooOrderFacts = {
  shopOrigin: "https://shop.example.com",
  connectionRevision: "grant_1",
  merchantItemId: "woo_merchant_11",
  priceId: "prc_1",
  productId: "11",
  productFingerprint: "accepted-download-fingerprint",
  amount: "25.00",
  currency: "USD",
};
const SHOP = "https://shop.example.com";
const RUPIAH = {
  currency: "IDR",
  rate: "18000",
  setAt: NOW,
  sessionSignedInAt: new Date("2026-10-19T07:30:00.000Z"),
  reference: { rate: "18035.292596", source: "Coinbase", readAt: NOW },
  confirmed: false,
};
const PERMISSION: WooPermission = {
  shopOrigin: "https://shop.example.com",
  productId: "11",
  orderKey: "wc_order_13",
  downloadId: "dl_guide",
  fileName: "Guide.txt",
  emailUid: "a".repeat(64),
  orderNumber: "WOO-13",
};

/**
 * The Postgres store has foreign keys onto the accounts table, so its suite
 * makes accounts first and passes their identifiers in.
 */
export interface ContractAccounts {
  readonly one: string;
  readonly other: string;
}

export const wooShopsContract = (
  name: string,
  open: () => Promise<{ shops: WooShops; accounts: ContractAccounts; close: () => Promise<void> }>,
): void => {
  const using = async (
    body: (shops: WooShops, accounts: ContractAccounts) => Promise<void>,
  ): Promise<void> => {
    const opened = await open();
    try {
      await body(opened.shops, opened.accounts);
    } finally {
      await opened.close();
    }
  };

  describe(`${name}: a Connect under way`, () => {
    const keys = {
      consumerKey: "ck_abc",
      consumerSecret: "cs_def",
      permissions: "read_write",
    };

    it("consumes the current grant together with writing its connection", async () => {
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "a-token",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: MUCH_LATER,
        });

        const connected = await shops.connectFromGrant("a-token", keys, NOW);

        expect(connected?.revision).toBe("a-token");
        expect((await shops.connectionOf(accounts.one))?.shopUrl).toBe("https://shop.example.com");
        expect(await shops.grantFor(accounts.one)).toBeNull();
        // The callback is unauthenticated by nature, so this is all that stops
        // somebody who saw a token from planting a second pair of keys on that
        // account.
        expect(await shops.connectFromGrant("a-token", keys, NOW)).toBeNull();
      });
    });

    it("lets one simultaneous callback consume and connect a grant", async () => {
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "a-token",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: MUCH_LATER,
        });

        // Sequential calls pass with a read followed by a write; two callbacks
        // in flight together would both read a live row and both write a
        // connection.
        const connected = await Promise.all(
          Array.from({ length: 10 }, () => shops.connectFromGrant("a-token", keys, NOW)),
        );

        expect(connected.filter((one) => one !== null)).toHaveLength(1);
      });
    });

    it("knows nothing about a token nobody issued", async () => {
      await using(async (shops) => {
        expect(await shops.connectFromGrant("not-a-token", keys, NOW)).toBeNull();
      });
    });

    it("refuses a token whose time is up but keeps the attempt visible", async () => {
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "a-token",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: LATER,
        });
        expect(await shops.connectFromGrant("a-token", keys, MUCH_LATER)).toBeNull();
        expect(await shops.connectionOf(accounts.one)).toBeNull();
        expect((await shops.grantFor(accounts.one))?.token).toBe("a-token");
      });
    });

    it("a new Connect supersedes only that account's previous attempt", async () => {
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "first",
          accountId: accounts.one,
          shopUrl: "https://first.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: LATER,
        });
        await shops.beginGrant({
          token: "other",
          accountId: accounts.other,
          shopUrl: "https://other.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: MUCH_LATER,
        });
        await shops.beginGrant({
          token: "second",
          accountId: accounts.one,
          shopUrl: "https://second.example.com",
          currency: null,
          startedAt: LATER,
          expiresAt: MUCH_LATER,
        });

        expect(await shops.connectFromGrant("first", keys, NOW)).toBeNull();
        expect(await shops.connectionOf(accounts.one)).toBeNull();
        expect((await shops.grantFor(accounts.one))?.token).toBe("second");
        expect((await shops.grantFor(accounts.other))?.token).toBe("other");
      });
    });

    it("hands back the Connect an account is waiting on, with the moment it started", async () => {
      // Without the moment, a screen cannot tell "a minute ago, wait" from "a
      // quarter of an hour ago, press Connect again".
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "a-token",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: MUCH_LATER,
        });

        const waiting = await shops.grantFor(accounts.one);

        expect(waiting?.shopUrl).toBe("https://shop.example.com");
        expect(waiting?.startedAt.toISOString()).toBe(NOW.toISOString());
      });
    });

    it("keeps one account's Connect out of another's", async () => {
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "a-token",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: MUCH_LATER,
        });

        expect(await shops.grantFor(accounts.other)).toBeNull();
      });
    });

    it("hands back the Connect a merchant pressed last, not the one before it", async () => {
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "first",
          accountId: accounts.one,
          shopUrl: "https://first.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: LATER,
        });
        await shops.beginGrant({
          token: "second",
          accountId: accounts.one,
          shopUrl: "https://second.example.com",
          currency: null,
          startedAt: LATER,
          expiresAt: MUCH_LATER,
        });

        expect((await shops.grantFor(accounts.one))?.shopUrl).toBe("https://second.example.com");
      });
    });

    it("still hands back a Connect whose time is up, because that is the case worth saying", async () => {
      // Not filtered here: an expired Connect with no keys is exactly the one a
      // merchant needs a sentence about, and the screen reads the clock.
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "a-token",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: LATER,
        });

        expect(await shops.grantFor(accounts.one)).not.toBeNull();
      });
    });
  });

  describe(`${name}: merchant recovery links`, () => {
    it("only lists this account's requested download recoveries without exposing sale or credential data", async () => {
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_unknown", FACTS, NOW);
        await shops.claimOrder(accounts.one, "ord_placed", FACTS, NOW);
        await shops.recordOrder(
          "ord_placed",
          { id: "13", number: "WOO-13", permission: PERMISSION, total: "25.00" },
          NOW,
        );
        await shops.claimOrder(accounts.one, "ord_hidden", FACTS, NOW);
        await shops.claimOrder(accounts.other, "ord_foreign", FACTS, NOW);
        await shops.claimOrder(accounts.one, "ord_parcel", { ...FACTS, kind: "parcel" }, NOW);
        await shops.recordPrecreateRefusal(accounts.one, "ord_refused", FACTS, NOW);
        await shops.recordPrecreateRefusal(
          accounts.one,
          "ord_refused_parcel",
          { ...FACTS, kind: "parcel" },
          NOW,
        );

        expect(
          await shops.recoverableOrders(accounts.one, [
            "ord_unknown",
            "ord_placed",
            "ord_foreign",
            "ord_parcel",
            "ord_refused",
            "ord_refused_parcel",
            "ord_missing",
          ]),
        ).toEqual(["ord_placed", "ord_refused", "ord_unknown"]);
        expect(await shops.recoverableOrders(accounts.one, [])).toEqual([]);
      });
    });
  });

  describe(`${name}: orders whose shop order nobody knows about`, () => {
    it("counts every claim still waiting for its shop's answer, and none placed or refused before", async () => {
      await using(async (shops, accounts) => {
        expect(await shops.uncertainOrders()).toBe(0);
        await shops.claimOrder(accounts.one, "ord_waiting", FACTS, NOW);
        await shops.claimOrder(accounts.other, "ord_waiting_too", FACTS, NOW);
        await shops.claimOrder(accounts.one, "ord_placed", FACTS, NOW);
        await shops.recordOrder(
          "ord_placed",
          { id: "13", number: "WOO-13", permission: PERMISSION, total: "25.00" },
          NOW,
        );
        await shops.recordPrecreateRefusal(accounts.one, "ord_refused", FACTS, NOW);

        expect(await shops.uncertainOrders()).toBe(2);
      });
    });
  });

  describe(`${name}: what the shop's orders total`, () => {
    it("keeps, for a sale from a shop in another currency, the shop's amount and the rate it was paid at", async () => {
      await using(async (shops, accounts) => {
        const converted = {
          inTheShop: { amount: "250000", currency: "IDR" },
          rate: { version: 7, rate: "18000", setAt: "2026-10-09T10:00:00.000Z" },
        };
        await shops.claimOrder(
          accounts.one,
          "ord_rupiah",
          { ...FACTS, amount: "13.89", converted },
          NOW,
        );
        await shops.recordOrder(
          "ord_rupiah",
          { id: "15", number: "WOO-15", permission: PERMISSION, total: "250001" },
          NOW,
        );

        expect(await shops.shopTotals(accounts.one, ["ord_rupiah"])).toEqual({
          ord_rupiah: { total: "250001", converted },
        });
      });
    });

    it("keeps the total each placed order recorded in the shop, for its own account alone", async () => {
      await using(async (shops, accounts) => {
        await shops.claimOrder(
          accounts.one,
          "ord_cent",
          { ...FACTS, kind: "parcel", amount: "31.99" },
          NOW,
        );
        await shops.recordOrder(
          "ord_cent",
          { id: "211", number: "211", permission: null, total: "32.00" },
          NOW,
        );
        await shops.claimOrder(accounts.one, "ord_even", FACTS, NOW);
        await shops.recordOrder(
          "ord_even",
          { id: "13", number: "WOO-13", permission: PERMISSION, total: "25.00" },
          NOW,
        );
        await shops.claimOrder(accounts.other, "ord_foreign", FACTS, NOW);
        await shops.recordOrder(
          "ord_foreign",
          { id: "14", number: "WOO-14", permission: PERMISSION, total: "25.01" },
          NOW,
        );
        await shops.claimOrder(accounts.one, "ord_unknown", FACTS, NOW);

        expect(
          await shops.shopTotals(accounts.one, [
            "ord_cent",
            "ord_even",
            "ord_foreign",
            "ord_unknown",
            "ord_missing",
          ]),
        ).toEqual({
          ord_cent: { total: "32.00", converted: null },
          ord_even: { total: "25.00", converted: null },
        });
        expect(await shops.shopTotals(accounts.one, [])).toEqual({});
      });
    });
  });

  describe(`${name}: a connected shop`, () => {
    const keys = {
      consumerKey: "ck_abc",
      consumerSecret: "cs_def",
      permissions: "read_write",
    };
    const connection = (accountId: string, shopUrl = "https://shop.example.com") => ({
      accountId,
      shopUrl,
      consumerKey: "ck_abc",
      consumerSecret: "cs_def",
      permissions: "read_write",
      revision: "grant_1",
      connectedAt: NOW,
      currency: null,
    });

    it("reads back what was written", async () => {
      await using(async (shops, accounts) => {
        await shops.connect(connection(accounts.one));
        const found = await shops.connectionOf(accounts.one);
        expect(found?.shopUrl).toBe("https://shop.example.com");
        expect(found?.consumerKey).toBe("ck_abc");
        expect(found?.consumerSecret).toBe("cs_def");
        expect(found?.permissions).toBe("read_write");
      });
    });

    it("is nothing for an account that has connected nothing", async () => {
      await using(async (shops, accounts) => {
        expect(await shops.connectionOf(accounts.other)).toBeNull();
      });
    });

    it.each(["https://other.example.com", "https://shop.example.com:8443"])(
      "keeps the connected shop when a pending grant names %s",
      async (shopUrl) => {
        await using(async (shops, accounts) => {
          await shops.beginGrant({
            token: "pending-token",
            accountId: accounts.one,
            shopUrl,
            currency: null,
            startedAt: NOW,
            expiresAt: MUCH_LATER,
          });
          const before = connection(accounts.one);
          await shops.connect(before);

          expect(await shops.connectFromGrant("pending-token", keys, LATER)).toBeNull();
          expect(await shops.connectionOf(accounts.one)).toStrictEqual(before);
        });
      },
    );

    it.each(["https://shop.example.com", "https://SHOP.example.com:443/"])(
      "renews credentials for the same shop at %s",
      async (shopUrl) => {
        await using(async (shops, accounts) => {
          await shops.connect(connection(accounts.one));
          await shops.beginGrant({
            token: "renewed-token",
            accountId: accounts.one,
            shopUrl,
            currency: null,
            startedAt: NOW,
            expiresAt: MUCH_LATER,
          });
          const renewed = { ...keys, consumerKey: "ck_renewed", consumerSecret: "cs_renewed" };

          const connected = await shops.connectFromGrant("renewed-token", renewed, LATER);

          expect(connected).toMatchObject({ ...renewed, revision: "renewed-token" });
          expect(await shops.connectionOf(accounts.one)).toStrictEqual(connected);
        });
      },
    );

    it("connects a different shop after the previous connection is forgotten", async () => {
      await using(async (shops, accounts) => {
        await shops.connect(connection(accounts.one));
        await shops.forget(accounts.one);
        await shops.beginGrant({
          token: "replacement-token",
          accountId: accounts.one,
          shopUrl: "https://other.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: MUCH_LATER,
        });

        const connected = await shops.connectFromGrant("replacement-token", keys, LATER);

        expect(connected?.shopUrl).toBe("https://other.example.com");
        expect(await shops.connectionOf(accounts.one)).toStrictEqual(connected);
      });
    });

    it("replaces a connection rather than keeping two", async () => {
      // Connecting a second shop means moving; two rows would be two shops to
      // place every order in.
      await using(async (shops, accounts) => {
        await shops.connect(connection(accounts.one, "https://first.example.com"));
        await shops.connect(connection(accounts.one, "https://second.example.com"));
        expect((await shops.connectionOf(accounts.one))?.shopUrl).toBe(
          "https://second.example.com",
        );
        expect(await shops.connections()).toHaveLength(1);
      });
    });

    it("keeps one merchant's shop out of another's", async () => {
      await using(async (shops, accounts) => {
        await shops.connect(connection(accounts.one, "https://first.example.com"));
        await shops.connect(connection(accounts.other, "https://second.example.com"));
        expect((await shops.connectionOf(accounts.one))?.shopUrl).toBe("https://first.example.com");
        expect((await shops.connectionOf(accounts.other))?.shopUrl).toBe(
          "https://second.example.com",
        );
      });
    });

    it("forgets one connection and every pending callback for only that account", async () => {
      await using(async (shops, accounts) => {
        await shops.connect(connection(accounts.one));
        await shops.beginGrant({
          token: "forgotten-token",
          accountId: accounts.one,
          shopUrl: "https://forgotten.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: MUCH_LATER,
        });
        await shops.beginGrant({
          token: "other-token",
          accountId: accounts.other,
          shopUrl: "https://other.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: MUCH_LATER,
        });
        expect(await shops.claimOrder(accounts.one, "ord_preserved", FACTS, NOW)).toStrictEqual({
          kind: "ours",
        });

        expect(await shops.forget(accounts.one)).toBe("https://shop.example.com");
        expect(await shops.connectionOf(accounts.one)).toBeNull();
        expect(await shops.connectFromGrant("forgotten-token", keys, NOW)).toBeNull();
        expect((await shops.grantFor(accounts.other))?.token).toBe("other-token");
        expect((await shops.knownOrder("ord_preserved"))?.kind).toBe("unknown");
      });
    });

    it("leaves no connection when Forget races the pending callback", async () => {
      await using(async (shops, accounts) => {
        await shops.connect(connection(accounts.one));
        await shops.beginGrant({
          token: "racing-token",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          currency: null,
          startedAt: NOW,
          expiresAt: MUCH_LATER,
        });

        await Promise.all([
          shops.connectFromGrant("racing-token", keys, NOW),
          shops.forget(accounts.one),
        ]);

        expect(await shops.connectionOf(accounts.one)).toBeNull();
        expect(await shops.grantFor(accounts.one)).toBeNull();
      });
    });
  });

  describe(`${name}: a price question`, () => {
    const DOLLAR_SALE = {
      fingerprint: FACTS.productFingerprint,
      inTheShop: { amount: "25.00", currency: "USD" },
      paid: { amount: "25.00", currency: "USD" },
      rateVersion: null,
    };

    it("binds one price id to one product, the amount the shop is held to and the dollars paid", async () => {
      await using(async (shops, accounts) => {
        expect(
          await shops.recordQuote(
            accounts.one,
            "prc_1",
            FACTS.merchantItemId,
            DOLLAR_SALE,
            MUCH_LATER,
            NOW,
          ),
        ).toBe(true);
        expect(await shops.quotedSale(accounts.one, "prc_1", FACTS.merchantItemId)).toEqual({
          fingerprint: FACTS.productFingerprint,
          inTheShop: { amount: "25.00", currency: "USD" },
          paid: { amount: "25.00", currency: "USD" },
          rate: null,
        });
        expect(await shops.quotedSale(accounts.other, "prc_1", FACTS.merchantItemId)).toBeNull();
        expect(
          await shops.recordQuote(
            accounts.one,
            "prc_1",
            FACTS.merchantItemId,
            { ...DOLLAR_SALE, fingerprint: "different-product" },
            MUCH_LATER,
            NOW,
          ),
        ).toBe(false);
      });
    });

    it("binds a price from a shop in another currency to the rate it was converted at, through later rates", async () => {
      await using(async (shops, accounts) => {
        const first = await shops.saveRate(accounts.one, SHOP, RUPIAH);
        const sale = {
          fingerprint: FACTS.productFingerprint,
          inTheShop: { amount: "250000", currency: "IDR" },
          paid: { amount: "13.89", currency: "USD" },
          rateVersion: first.version,
        };
        expect(
          await shops.recordQuote(
            accounts.one,
            "prc_2",
            FACTS.merchantItemId,
            sale,
            MUCH_LATER,
            NOW,
          ),
        ).toBe(true);
        await shops.saveRate(accounts.one, SHOP, { ...RUPIAH, rate: "16000", setAt: LATER });

        expect(await shops.quotedSale(accounts.one, "prc_2", FACTS.merchantItemId)).toEqual({
          fingerprint: FACTS.productFingerprint,
          inTheShop: { amount: "250000", currency: "IDR" },
          paid: { amount: "13.89", currency: "USD" },
          rate: { version: first.version, currency: "IDR", rate: "18000", setAt: NOW },
        });
        // A second answer to the same question at another amount or rate is
        // a price no order could be held to.
        for (const other of [
          { ...sale, inTheShop: { amount: "250001", currency: "IDR" } },
          { ...sale, paid: { amount: "13.90", currency: "USD" } },
          { ...sale, rateVersion: null },
        ]) {
          expect(
            await shops.recordQuote(
              accounts.one,
              "prc_2",
              FACTS.merchantItemId,
              other,
              MUCH_LATER,
              NOW,
            ),
          ).toBe(false);
        }
      });
    });
  });

  describe(`${name}: the rates a merchant sets`, () => {
    it("keeps every rate saved, and the latest for the shop and the currency is the current one", async () => {
      await using(async (shops, accounts) => {
        const first = await shops.saveRate(accounts.one, SHOP, RUPIAH);
        expect(await shops.currentRate(accounts.one, SHOP, "IDR")).toEqual({
          version: first.version,
          ...RUPIAH,
        });

        const second = await shops.saveRate(accounts.one, SHOP, {
          ...RUPIAH,
          rate: "17950.5",
          setAt: LATER,
          sessionSignedInAt: null,
          reference: null,
          confirmed: true,
        });
        expect(second.version).toBeGreaterThan(first.version);
        expect(await shops.currentRate(accounts.one, SHOP, "IDR")).toEqual({
          version: second.version,
          ...RUPIAH,
          rate: "17950.5",
          setAt: LATER,
          sessionSignedInAt: null,
          reference: null,
          confirmed: true,
        });
      });
    });

    it("has no rate for another currency, another shop or another account", async () => {
      await using(async (shops, accounts) => {
        const saved = await shops.saveRate(accounts.one, SHOP, RUPIAH);

        expect(await shops.currentRate(accounts.one, SHOP, "EUR")).toBeNull();
        expect(
          await shops.currentRate(accounts.one, "https://other.example.com", "IDR"),
        ).toBeNull();
        expect(await shops.currentRate(accounts.other, SHOP, "IDR")).toBeNull();
        expect(saved.version).toBeGreaterThan(0);
      });
    });
  });

  describe(`${name}: the currency a shop sells in`, () => {
    it("carries the currency read at Connect onto the connection, and the one an import reads after it", async () => {
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "a-token",
          accountId: accounts.one,
          shopUrl: SHOP,
          currency: { code: "IDR", decimals: 0 },
          startedAt: NOW,
          expiresAt: MUCH_LATER,
        });
        const connected = await shops.connectFromGrant(
          "a-token",
          { consumerKey: "ck_abc", consumerSecret: "cs_def", permissions: "read_write" },
          NOW,
        );
        expect(connected?.currency).toEqual({ code: "IDR", decimals: 0 });

        await shops.noteCurrency(accounts.one, { code: "EUR", decimals: 2 });
        expect((await shops.connectionOf(accounts.one))?.currency).toEqual({
          code: "EUR",
          decimals: 2,
        });
        await shops.noteCurrency(accounts.other, { code: "JPY", decimals: 0 });
        expect(await shops.connectionOf(accounts.other)).toBeNull();
      });
    });

    it("knows no currency for a shop whose catalogue gave none at Connect", async () => {
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "a-token",
          accountId: accounts.one,
          shopUrl: SHOP,
          currency: null,
          startedAt: NOW,
          expiresAt: MUCH_LATER,
        });
        const connected = await shops.connectFromGrant(
          "a-token",
          { consumerKey: "ck_abc", consumerSecret: "cs_def", permissions: "read_write" },
          NOW,
        );
        expect(connected?.currency).toBeNull();
      });
    });
  });

  describe(`${name}: orders already placed`, () => {
    it("gives the first attempt the sale", async () => {
      await using(async (shops, accounts) => {
        expect(await shops.claimOrder(accounts.one, "ord_1", FACTS, NOW)).toEqual({
          kind: "ours",
        });
        expect((await shops.knownOrder("ord_1"))?.kind).toBe("unknown");
      });
    });

    it("gives one sale to one attempt when several arrive at the same moment", async () => {
      // A redelivery landing while the first attempt is in flight: two attempts
      // that both read "nobody has this" would place two orders for one
      // payment.
      await using(async (shops, accounts) => {
        const claims = await Promise.all(
          Array.from({ length: 10 }, () => shops.claimOrder(accounts.one, "ord_1", FACTS, NOW)),
        );
        expect(claims.filter((one) => one.kind === "ours")).toHaveLength(1);
      });
    });

    it("hands a repeat the order the shop already made", async () => {
      // Delivery is at least once; without this a second hand-over is a second
      // order in the merchant's shop.
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_1", FACTS, NOW);
        await shops.recordOrder(
          "ord_1",
          { id: "13", number: "WOO-13", permission: PERMISSION, total: "25.00" },
          NOW,
        );
        expect(await shops.claimOrder(accounts.one, "ord_1", FACTS, LATER)).toEqual({
          kind: "placed",
          id: "13",
          number: "WOO-13",
          permission: PERMISSION,
        });
      });
    });

    it("hands a repeat of a parcel's sale the shop's order, with nothing to deliver", async () => {
      // A parcel's order in the shop is the whole result: no permission is kept
      // and the address never is. A repeat is the same order taken on again.
      await using(async (shops, accounts) => {
        const parcel = { ...FACTS, kind: "parcel" as const };
        await shops.claimOrder(accounts.one, "ord_1", parcel, NOW);
        expect(
          await shops.recordOrder(
            "ord_1",
            { id: "30", number: "30", permission: null, total: "25.00" },
            NOW,
          ),
        ).toBe(true);
        const placed = { kind: "placed_parcel", id: "30", number: "30" };
        expect(await shops.claimOrder(accounts.one, "ord_1", parcel, LATER)).toEqual(placed);
        expect(await shops.knownOrder("ord_1")).toEqual(placed);
        expect((await shops.recoveryOrder("ord_1"))?.facts.kind).toBe("parcel");
      });
    });

    it("follows a placed parcel until it ships or the shop ends it, and then lets go", async () => {
      await using(async (shops, accounts) => {
        const parcel = { ...FACTS, kind: "parcel" as const };
        for (const orderId of ["ord_1", "ord_2"]) {
          await shops.claimOrder(accounts.one, orderId, parcel, NOW);
          await shops.recordOrder(
            orderId,
            { id: `w_${orderId}`, number: "30", permission: null, total: "25.00" },
            NOW,
          );
        }
        await shops.claimOrder(accounts.other, "ord_3", parcel, NOW);
        await shops.recordOrder(
          "ord_3",
          { id: "w_ord_3", number: "31", permission: null, total: "25.00" },
          NOW,
        );

        // Where and when it was sold decide whether it is still read: in the
        // shop connected now, and not for ever.
        expect(await shops.parcelsToFollow(accounts.one)).toEqual([
          { orderId: "ord_1", wooOrderId: "w_ord_1", shopOrigin: FACTS.shopOrigin, placedAt: NOW },
          { orderId: "ord_2", wooOrderId: "w_ord_2", shopOrigin: FACTS.shopOrigin, placedAt: NOW },
        ]);
        expect(await shops.endParcel("ord_1", "shipped", LATER)).toBe(true);
        expect(await shops.endParcel("ord_2", "closed", LATER)).toBe(true);
        // Ended once: a second ending of either kind changes nothing.
        expect(await shops.endParcel("ord_1", "closed", LATER)).toBe(false);
        expect(await shops.parcelsToFollow(accounts.one)).toEqual([]);
        // An ended parcel is still a sale the shop holds, and is never placed
        // again.
        expect(await shops.knownOrder("ord_1")).toEqual({
          kind: "placed_parcel",
          id: "w_ord_1",
          number: "30",
        });
        expect((await shops.parcelsToFollow(accounts.other)).map((one) => one.orderId)).toEqual([
          "ord_3",
        ]);
      });
    });

    it("says it does not know, for an attempt that never came back", async () => {
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_1", FACTS, NOW);
        const again = await shops.claimOrder(accounts.one, "ord_1", FACTS, LATER);
        expect(again.kind).toBe("unknown");
        expect(again.kind === "unknown" && again.attemptedAt.toISOString()).toBe(NOW.toISOString());
      });
    });

    it("does not downgrade an in-flight create claim to a pre-create refusal", async () => {
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_1", FACTS, NOW);
        await shops.recordPrecreateRefusal(accounts.one, "ord_1", FACTS, LATER);
        expect((await shops.claimOrder(accounts.one, "ord_1", FACTS, LATER)).kind).toBe("unknown");
      });
    });

    it("will not replace a placed sale with a refusal", async () => {
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_1", FACTS, NOW);
        await shops.recordOrder(
          "ord_1",
          { id: "13", number: "WOO-13", permission: PERMISSION, total: "25.00" },
          NOW,
        );
        await shops.recordPrecreateRefusal(accounts.one, "ord_1", FACTS, LATER);
        expect(await shops.claimOrder(accounts.one, "ord_1", FACTS, LATER)).toEqual({
          kind: "placed",
          id: "13",
          number: "WOO-13",
          permission: PERMISSION,
        });
      });
    });

    it("keeps one sale's record out of another's", async () => {
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_1", FACTS, NOW);
        await shops.recordOrder(
          "ord_1",
          { id: "13", number: "WOO-13", permission: PERMISSION, total: "25.00" },
          NOW,
        );
        expect(await shops.claimOrder(accounts.one, "ord_2", FACTS, NOW)).toEqual({
          kind: "ours",
        });
      });
    });

    it("binds an uncertain sale to one exact shop order", async () => {
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_1", FACTS, NOW);
        await shops.recordOrder(
          "ord_1",
          { id: "13", number: "WOO-13", permission: PERMISSION, total: "25.00" },
          NOW,
        );
        await shops.recordOrder(
          "ord_1",
          {
            id: "14",
            number: "WOO-14",
            permission: { ...PERMISSION, orderKey: "wc_order_14", orderNumber: "WOO-14" },
            total: "25.00",
          },
          LATER,
        );

        expect(await shops.knownOrder("ord_1")).toEqual({
          kind: "placed",
          id: "13",
          number: "WOO-13",
          permission: PERMISSION,
        });
      });
    });

    it("reopens a refusal before creation once, and only under a shop connected again", async () => {
      await using(async (shops, accounts) => {
        await shops.recordPrecreateRefusal(accounts.one, "ord_1", FACTS, NOW);
        expect(await shops.beginPrecreateRecovery("ord_1", "grant_1", LATER)).toBe(false);
        expect(await shops.beginPrecreateRecovery("ord_1", "grant_2", LATER)).toBe(true);
        expect(await shops.beginPrecreateRecovery("ord_1", "grant_2", LATER)).toBe(false);
        expect(await shops.beginPrecreateRecovery("ord_1", "grant_3", LATER)).toBe(false);

        expect(await shops.recoveryOrder("ord_1")).toMatchObject({
          orderId: "ord_1",
          accountId: accounts.one,
          phase: "create_unknown",
          facts: { connectionRevision: "grant_2" },
          placed: null,
        });
        expect(await shops.knownOrder("ord_1")).toEqual({ kind: "unknown", attemptedAt: LATER });
      });
    });

    it("lets one of two presses at once reopen a refusal before creation, and not the other", async () => {
      await using(async (shops, accounts) => {
        await shops.recordPrecreateRefusal(accounts.one, "ord_1", FACTS, NOW);

        const both = await Promise.all([
          shops.beginPrecreateRecovery("ord_1", "grant_2", LATER),
          shops.beginPrecreateRecovery("ord_1", "grant_2", LATER),
        ]);

        expect(both.filter(Boolean)).toHaveLength(1);
      });
    });
  });
};
