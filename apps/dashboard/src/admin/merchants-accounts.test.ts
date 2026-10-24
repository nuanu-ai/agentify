/**
 * The identity's read of the accounts behind merchants, which the workspace's
 * Merchants list and a merchant's page draw an account's address from and the
 * list's search finds a merchant by. If this fails, the list shows a merchant
 * with no seller name as nobody, or a search by the address a merchant pasted
 * finds the wrong merchant or none.
 */

import { afterEach, describe, expect, it } from "vitest";
import { type AdminServed, adminServed } from "../testing/admin.js";

let served: AdminServed | null = null;

afterEach(async () => {
  await served?.close();
  served = null;
});

const accountOf = async (open: AdminServed, email: string) => {
  const merchant = await open.harnessed.addMerchant(email.slice(0, 32));
  await open.identity.make(email, merchant.id);
  return merchant.id;
};

describe("the accounts behind merchants", () => {
  it("names the account of each merchant asked for, and of none other", async () => {
    served = await adminServed();
    const coffee = await accountOf(served, "owner@coffee.example");
    await accountOf(served, "owner@tours.example");

    const found = await served.identity.merchantAccounts({ merchantIds: [coffee, "mch_nobody"] });

    expect(found.map(({ merchantId, email }) => [merchantId, email])).toStrictEqual([
      [coffee, "owner@coffee.example"],
    ]);
  });

  it("finds merchants by text in their account's address, ignoring case and reading no wildcard", async () => {
    served = await adminServed();
    const coffee = await accountOf(served, "owner_1@coffee.example");
    await accountOf(served, "owner21@tours.example");
    const emailsFound = async (text: string) =>
      (await served?.identity.merchantAccounts({ emailContains: text }))?.map(
        (account) => account.merchantId,
      );

    expect(await emailsFound("  COFFEE.ex ")).toStrictEqual([coffee]);
    expect(await emailsFound("owner_1")).toStrictEqual([coffee]);
    expect(await emailsFound("nobody")).toStrictEqual([]);
    expect(await emailsFound("")).toStrictEqual([]);
  });

  it("leaves out an account that made no merchant", async () => {
    served = await adminServed();
    await served.identity.requestLink("visitor@nowhere.example", "default", {
      client: "192.0.2.11",
    });
    const link = new URL(/(https?:\/\/\S+)/.exec(served.mails.at(-1)?.body ?? "")?.[1] ?? "");
    const opened = await served.identity.openLink(link.searchParams.get("token") ?? "");
    expect(opened.status).toBe("opened");

    expect(await served.identity.merchantAccounts({ emailContains: "nowhere" })).toStrictEqual([]);
  });
});
