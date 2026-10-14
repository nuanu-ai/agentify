/**
 * A gateway over a payout wallet stored in another spelling than its split's
 * row, run against memory under `pnpm test` and against Postgres under
 * `pnpm test:db`. A wallet may be stored in lower case, while every row of the
 * registry names its wallet in the checksummed spelling the rule makes. One address in two spellings is one wallet: its
 * merchant sells at its split, a change from it is announced from that split,
 * and a return to it finds that row.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RecordingAnnouncer } from "../adapters/memory/announcer.js";
import { ScriptedFacilitator } from "../adapters/memory/facilitator.js";
import { MemoryQueue } from "../adapters/memory/queue.js";
import { Gateway } from "../app/gateway.js";
import { setServiceName } from "../app/merchants.js";
import { loadConfig } from "../config.js";
import type { PayoutWalletRead, Store } from "../ports/store.js";
import { payoutSplitNetworkOf } from "../split/networks.js";
import { payoutSplitFor } from "../split/parameters.js";
import { countedIds, loggedWhile } from "./harness.js";
import { SPLIT_NETWORKS_WITH_A_FIXTURE_BASE } from "./split-networks.js";

/** A database a gateway is about to start on, empty but for what a case writes into it. */
export interface WalletSpellingDatabase {
  readonly store: Store;
  /**
   * Writes a merchant's wallet columns exactly as given and records no split,
   * as a wallet written without its split is found.
   */
  writeWalletWithoutSplit(merchantId: string, wallet: PayoutWalletRead): Promise<void>;
}

const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const P = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

const TEST_CHANNEL = "eip155:84532";
const LIVE_CHANNEL = "eip155:8453";
const LIVE = {
  PAYMENT_NETWORK: LIVE_CHANNEL,
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "key-secret",
};
const SIGNED_IN = { kind: "signed_in", email: "owner@example.com" } as const;

const card: Card = {
  merchant_item_id: "a-room",
  title: "A room",
  description: "A room sold by the merchant who published this card",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

/**
 * Runs every case against the databases `open` returns, each empty and opened
 * for the network named.
 */
export function describeWalletSpelling(
  name: string,
  open: (network: string) => Promise<WalletSpellingDatabase>,
): void {
  describe(name, () => {
    let now = Date.parse("2026-10-14T12:00:00.000Z");
    const running: Gateway[] = [];

    afterEach(async () => {
      for (const gateway of running.splice(0)) await gateway.stop();
      now = Date.parse("2026-10-14T12:00:00.000Z");
    });

    const gatewayOn = (database: WalletSpellingDatabase, environment: Record<string, string>) => {
      const announcer = new RecordingAnnouncer();
      const gateway = new Gateway({
        config: loadConfig(
          { DATABASE_URL: "postgres://agentify@localhost:5432/agentify", ...environment },
          SPLIT_NETWORKS_WITH_A_FIXTURE_BASE,
        ),
        store: database.store,
        queue: new MemoryQueue(),
        facilitator: new ScriptedFacilitator(),
        clock: () => now,
        ids: countedIds(),
        announcer,
      });
      running.push(gateway);
      return { gateway, announcer };
    };

    /** A named merchant paid at W in lower case, with no split recorded, on this network. */
    const paidInLowerCase = async (network: string) => {
      const database = await open(network);
      const id = "mch_lower";
      await database.store.addMerchant({ id, name: id }, now);
      await setServiceName(database.store, id, "Shop lower", now);
      await database.writeWalletWithoutSplit(id, { address: W.toLowerCase(), pending: null });
      const split = (wallet: string) =>
        payoutSplitFor(
          payoutSplitNetworkOf(SPLIT_NETWORKS_WITH_A_FIXTURE_BASE, network),
          id,
          wallet,
        );
      return { database, id, split };
    };

    it("sells at the split the start records for it, and a later start records and says nothing", async () => {
      const { database, id, split } = await paidInLowerCase(TEST_CHANNEL);
      const stored = await database.store.publishCard(id, card, now);
      const started = now;

      const first = await loggedWhile(() => gatewayOn(database, {}).gateway.start());
      now += 60_000;
      const again = await loggedWhile(() => gatewayOn(database, {}).gateway.start());

      expect(first).toMatch(/recorded 1 payout split\b/);
      expect(again).not.toMatch(/payout split/);
      expect((await database.store.merchantById(id))?.payoutWallet.split).toStrictEqual({
        ...split(W),
        recordedAt: started,
      });
      expect((await gatewayOn(database, {}).gateway.paidResource(stored.id))?.payTo).toBe(
        split(W).address,
      );
    });

    it("on the live deployment, is replaced by a change announced from its recorded split, and the change is recorded", async () => {
      const { database, id, split } = await paidInLowerCase(LIVE_CHANNEL);
      const { gateway, announcer } = gatewayOn(database, LIVE);
      await gateway.start();

      const answered = await gateway.setPayoutWallet(id, P, SIGNED_IN);

      expect(answered).toMatchObject({ pending: { payout_wallet: P } });
      expect(announcer.announced).toMatchObject([
        { kind: "wallet_change", from_split: split(W).address, to: P, to_split: split(P).address },
      ]);
      const wallet = (await database.store.merchantById(id))?.payoutWallet;
      expect(wallet?.split?.address).toBe(split(W).address);
      expect(wallet?.pending?.split?.address).toBe(split(P).address);
    });

    it("on the live deployment, asked for again in the checksummed spelling while a change waits, cancels the change and keeps its first row", async () => {
      const { database, id, split } = await paidInLowerCase(LIVE_CHANNEL);
      const { gateway, announcer } = gatewayOn(database, LIVE);
      const started = now;
      await gateway.start();
      now += 60_000;
      await gateway.setPayoutWallet(id, P, SIGNED_IN);
      now += 60_000;

      const answered = await gateway.setPayoutWallet(id, W, SIGNED_IN);

      expect(announcer.announced.map((one) => one.kind)).toStrictEqual([
        "wallet_change",
        "wallet_change_cancelled",
      ]);
      expect(answered).toStrictEqual({ payout_wallet: W, pending: null });
      expect((await database.store.merchantById(id))?.payoutWallet.split).toStrictEqual({
        ...split(W),
        recordedAt: started,
      });
    });

    it("on the live deployment, asked for again in the checksummed spelling with nothing waiting, changes nothing and tells nobody", async () => {
      const { database, id } = await paidInLowerCase(LIVE_CHANNEL);
      const { gateway, announcer } = gatewayOn(database, LIVE);
      await gateway.start();

      const answered = await gateway.setPayoutWallet(id, W, SIGNED_IN);

      expect(announcer.announced).toStrictEqual([]);
      expect(answered).toMatchObject({ pending: null });
      expect((await database.store.merchantById(id))?.payoutWallet.pending).toBeNull();
    });
  });
}
