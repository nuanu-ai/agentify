/**
 * What the identity's reads for the operator's workspace promise, run over
 * memory rows in `pnpm test` and over Postgres as a db-test, so Health's link
 * ceiling, the overview's owners and the ad reports' row say the same of the
 * same rows whichever store holds them. Each case hands `open` the rows to
 * hold, one shape for both.
 */

import { describe, expect, it } from "vitest";
import type { DashboardIdentity } from "../dashboard-entry.js";

const NOW = new Date("2026-10-24T09:00:00.000Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

export interface AdminReadRows {
  readonly accounts: readonly { id: string; email: string; merchantId: string | null }[];
  readonly linkSends: readonly { id: string; purpose: string; sentAt: Date }[];
  readonly adReports: readonly {
    accountId: string;
    event: "reg" | "store_connected";
    state: string;
    settledAt: Date | null;
  }[];
}

const ROWS: AdminReadRows = {
  accounts: [
    { id: "acc_1", email: "owner@shop.example", merchantId: "mch_a" },
    { id: "acc_2", email: "second@shop.example", merchantId: "mch_b" },
    { id: "acc_3", email: "reader@example.com", merchantId: null },
  ],
  linkSends: [
    { id: "ls_1", purpose: "dashboard", sentAt: ago(5 * MINUTE) },
    { id: "ls_2", purpose: "dashboard", sentAt: ago(59 * MINUTE) },
    { id: "ls_3", purpose: "dashboard", sentAt: ago(61 * MINUTE) },
    { id: "ls_4", purpose: "report", sentAt: ago(10 * MINUTE) },
    { id: "ls_5", purpose: "step-up", sentAt: ago(MINUTE) },
  ],
  adReports: [
    { accountId: "acc_1", event: "reg", state: "delivered", settledAt: ago(2 * DAY) },
    { accountId: "acc_1", event: "store_connected", state: "waiting", settledAt: null },
    { accountId: "acc_2", event: "reg", state: "refused", settledAt: ago(DAY) },
    { accountId: "acc_2", event: "store_connected", state: "pending", settledAt: null },
    { accountId: "acc_3", event: "reg", state: "given_up", settledAt: ago(40 * DAY) },
  ],
};

export function describeAdminReads(
  name: string,
  open: (rows: AdminReadRows) => Promise<DashboardIdentity>,
): void {
  describe(name, () => {
    it("counts the links of each purpose sent in the rolling hour, and none older", async () => {
      const identity = await open(ROWS);

      expect(await identity.linksSentInTheHour(NOW)).toStrictEqual({
        dashboard: 2,
        report: 1,
        "step-up": 1,
      });
    });

    it("counts no link on a channel that sent none, from a read that succeeded", async () => {
      const identity = await open({ ...ROWS, linkSends: [] });

      expect(await identity.linksSentInTheHour(NOW)).toStrictEqual({
        dashboard: 0,
        report: 0,
        "step-up": 0,
      });
    });

    it("names the accounts asked for by identifier or by their merchant, and nobody else", async () => {
      const identity = await open(ROWS);

      const byMerchant = await identity.accountsNamed({ merchantIds: ["mch_b"] });
      const byId = await identity.accountsNamed({ accountIds: ["acc_3", "acc_unknown"] });
      const both = await identity.accountsNamed({ accountIds: ["acc_1"], merchantIds: ["mch_b"] });

      expect(byMerchant).toStrictEqual([
        { id: "acc_2", email: "second@shop.example", merchantId: "mch_b" },
      ]);
      expect(byId).toStrictEqual([{ id: "acc_3", email: "reader@example.com", merchantId: null }]);
      expect(both.map((account) => account.id).sort()).toStrictEqual(["acc_1", "acc_2"]);
      expect(await identity.accountsNamed({})).toStrictEqual([]);
    });

    it("counts the ad reports settled since a moment by how they ended, and every one waiting", async () => {
      const identity = await open(ROWS);

      expect(await identity.adReportsSince(ago(30 * DAY))).toStrictEqual({
        delivered: 1,
        refused: 1,
        givenUp: 0,
        waiting: 2,
      });
    });
  });
}
