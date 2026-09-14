/**
 * What a store of WooCommerce connections has to do, whichever one it is.
 *
 * Two implementations satisfy it — the memory one the offline suite runs on and
 * the Postgres one a deployment runs on — and the two are held to this one list
 * rather than to two copies of it, because the properties that matter are the
 * ones that are easiest to have in one and not the other: a token that works
 * once, and a sale that is placed in somebody's shop once.
 */

import { describe, expect, it } from "vitest";
import type { WooShops } from "../woo-shops.js";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const LATER = new Date("2026-09-14T12:10:00.000Z");
const MUCH_LATER = new Date("2026-09-14T13:00:00.000Z");

/**
 * Who the rows belong to.
 *
 * The Postgres implementation has foreign keys onto the accounts table, so the
 * suite running against a database makes the accounts first and passes their
 * identifiers in. The memory one has no such need and passes anything.
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
    it("hands back the Connect the token names", async () => {
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "a-token",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          expiresAt: MUCH_LATER,
        });
        const spent = await shops.spendGrant("a-token", NOW);
        expect(spent?.accountId).toBe(accounts.one);
        expect(spent?.shopUrl).toBe("https://shop.example.com");
      });
    });

    it("spends a token once and never again", async () => {
      // The callback is unauthenticated by nature, so this is the whole of what
      // stops somebody who saw a token planting a second pair of keys on that
      // account afterwards.
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "a-token",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          expiresAt: MUCH_LATER,
        });
        expect(await shops.spendGrant("a-token", NOW)).not.toBeNull();
        expect(await shops.spendGrant("a-token", NOW)).toBeNull();
      });
    });

    it("knows nothing about a token nobody issued", async () => {
      await using(async (shops) => {
        expect(await shops.spendGrant("not-a-token", NOW)).toBeNull();
      });
    });

    it("refuses a token whose time is up, and takes the row away with it", async () => {
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "a-token",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          expiresAt: LATER,
        });
        expect(await shops.spendGrant("a-token", MUCH_LATER)).toBeNull();
        // Gone rather than left to expire again: a stale token is exactly what
        // somebody replaying an old callback would be holding.
        expect(await shops.spendGrant("a-token", NOW)).toBeNull();
      });
    });

    it("clears out the Connects nobody came back for", async () => {
      await using(async (shops, accounts) => {
        await shops.beginGrant({
          token: "stale",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          expiresAt: LATER,
        });
        await shops.beginGrant({
          token: "live",
          accountId: accounts.one,
          shopUrl: "https://shop.example.com",
          expiresAt: MUCH_LATER,
        });
        expect(await shops.sweepGrants(new Date(MUCH_LATER.getTime() - 1))).toBe(1);
        expect(await shops.spendGrant("live", NOW)).not.toBeNull();
      });
    });
  });

  describe(`${name}: a connected shop`, () => {
    const connection = (accountId: string, shopUrl = "https://shop.example.com") => ({
      accountId,
      shopUrl,
      consumerKey: "ck_abc",
      consumerSecret: "cs_def",
      permissions: "read_write",
      connectedAt: NOW,
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

    it("replaces a connection rather than keeping two", async () => {
      // A merchant who connects a second shop meant to move, and two rows would
      // be two shops to place every order in.
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

    it("forgets one", async () => {
      await using(async (shops, accounts) => {
        await shops.connect(connection(accounts.one));
        await shops.forget(accounts.one);
        expect(await shops.connectionOf(accounts.one)).toBeNull();
      });
    });
  });

  describe(`${name}: orders already placed`, () => {
    it("gives the first attempt the sale", async () => {
      await using(async (shops, accounts) => {
        expect(await shops.claimOrder(accounts.one, "ord_1", NOW)).toEqual({ kind: "ours" });
      });
    });

    it("hands a repeat the order the shop already made", async () => {
      // A delivery is at least once. Without this, the second hand-over of one
      // sale is a second order in the merchant's shop to pick, pack and post.
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_1", NOW);
        await shops.recordOrder("ord_1", { id: "13", number: "WOO-13" }, NOW);
        expect(await shops.claimOrder(accounts.one, "ord_1", LATER)).toEqual({
          kind: "placed",
          id: "13",
          number: "WOO-13",
        });
      });
    });

    it("says it does not know, for an attempt that never came back", async () => {
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_1", NOW);
        const again = await shops.claimOrder(accounts.one, "ord_1", LATER);
        expect(again.kind).toBe("unknown");
        expect(again.kind === "unknown" && again.attemptedAt.toISOString()).toBe(NOW.toISOString());
      });
    });

    it("lets an attempt that decided nothing give the sale back", async () => {
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_1", NOW);
        await shops.releaseOrder("ord_1");
        expect(await shops.claimOrder(accounts.one, "ord_1", LATER)).toEqual({ kind: "ours" });
      });
    });

    it("will not give back a sale the shop has an order for", async () => {
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_1", NOW);
        await shops.recordOrder("ord_1", { id: "13", number: "WOO-13" }, NOW);
        await shops.releaseOrder("ord_1");
        expect(await shops.claimOrder(accounts.one, "ord_1", LATER)).toEqual({
          kind: "placed",
          id: "13",
          number: "WOO-13",
        });
      });
    });

    it("keeps one sale's record out of another's", async () => {
      await using(async (shops, accounts) => {
        await shops.claimOrder(accounts.one, "ord_1", NOW);
        await shops.recordOrder("ord_1", { id: "13", number: "WOO-13" }, NOW);
        expect(await shops.claimOrder(accounts.one, "ord_2", NOW)).toEqual({ kind: "ours" });
      });
    });
  });
};
