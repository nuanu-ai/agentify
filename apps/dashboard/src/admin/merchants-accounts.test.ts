/**
 * The identity's search of accounts by their address, which the workspace's
 * Merchants list finds a merchant by when an operator pastes the address its
 * owner wrote from. If this fails, that search finds the wrong merchant or
 * none.
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

describe("the accounts found by their address", () => {
  it("finds by text in the address, ignoring case, with the merchant each made", async () => {
    served = await adminServed();
    const coffee = await accountOf(served, "owner_1@coffee.example");
    await accountOf(served, "owner21@tours.example");
    const found = async (text: string) =>
      (await served?.identity.accountsWithEmailContaining(text))?.accounts.map((one) => [
        one.email,
        one.merchantId,
      ]);

    expect(await found("  COFFEE.ex ")).toStrictEqual([["owner_1@coffee.example", coffee]]);
    expect(await found("owner_1")).toStrictEqual([["owner_1@coffee.example", coffee]]);
    expect(await found("nobody")).toStrictEqual([]);
    expect(await found("   ")).toStrictEqual([]);
  });

  it("names an account that made no merchant as having none", async () => {
    served = await adminServed();
    await served.identity.requestLink("visitor@nowhere.example", "default", {
      client: "192.0.2.11",
    });
    const link = new URL(/(https?:\/\/\S+)/.exec(served.mails.at(-1)?.body ?? "")?.[1] ?? "");
    const opened = await served.identity.openLink(link.searchParams.get("token") ?? "");
    expect(opened.status).toBe("opened");

    const found = await served.identity.accountsWithEmailContaining("nowhere");

    expect(found.cut).toBe(false);
    expect(found.accounts.map((one) => [one.email, one.merchantId])).toStrictEqual([
      ["visitor@nowhere.example", null],
    ]);
  });
});
