/**
 * The workspace's Merchants list and a merchant's page over HTTP, as an
 * operator meets them: what they show, and what each press on a merchant
 * changes, records and refuses. Each case names the promise to the operator
 * or to the merchant that breaks when it fails.
 */

import { PAYOUT_SPLIT_NETWORKS, payoutSplitFor, payoutSplitNetworkOf } from "@agentify/gateway";
import { memoryOperatorReader, type OperatorReader } from "@agentify/gateway/operator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AdminServed, adminServed } from "../testing/admin.js";
import { memoryWooShops } from "../woo-shops.js";
import type { Operator } from "./access.js";
import { CONFIRM_FIELD, CONFIRMED, REASON_FIELD } from "./fields.js";
import { merchantsFor } from "./merchants.js";
import { WITHDRAWAL_NOTE } from "./merchants-words.js";
import type { AdminParts } from "./parts.js";

let served: AdminServed | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await served?.close();
  served = null;
});

const OPERATOR = "op@agentify.example";
const TICKED = { [CONFIRM_FIELD]: CONFIRMED };

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const rowsAbout = async (open: AdminServed, merchantId: string) =>
  (await open.harnessed.store.journal({ about: { merchant: merchantId }, limit: 50 })).rows;

describe("the Merchants list", () => {
  it("names a merchant without a seller name by its account's address, and finds it by that address", async () => {
    served = await adminServed();
    const named = await served.harnessed.addMerchant("Coffee Roasters");
    const unnamed = await served.harnessed.gateway.registerMerchant();
    await served.identity.make("owner@unnamed.example", unnamed);
    const operator = await served.signedIn(OPERATOR, { operator: true });

    const all = await operator.get("/admin/merchants");
    const found = await operator.get("/admin/merchants?q=UNNAMED.example");

    expect(all.status).toBe(200);
    expect(text(all.html)).toContain("Coffee Roasters");
    expect(text(all.html)).toContain("Seller name not set owner@unnamed.example");
    expect(text(found.html)).toContain("owner@unnamed.example");
    expect(text(found.html)).not.toContain("Coffee Roasters");
    expect(all.html).toContain(`/admin/merchants/${named.id}`);
  });

  it("says a search found nobody, rather than drawing an empty channel", async () => {
    served = await adminServed();
    await served.harnessed.addMerchant("Coffee Roasters");
    const operator = await served.signedIn(OPERATOR, { operator: true });

    const answered = await operator.get("/admin/merchants?q=nobody-at-all");

    expect(text(answered.html)).toContain("No merchant matches “nobody-at-all”");
    expect(text(answered.html)).toContain("Clear the search");
  });

  it("leads past the first fifty merchants a page at a time, and draws the last for a page past it", async () => {
    // Past fifty rows the list had no way to the rest but a search.
    served = await adminServed();
    for (let at = 0; at < 52; at += 1) {
      await served.harnessed.addMerchant(`Shop ${String(at).padStart(2, "0")}`);
    }
    const operator = await served.signedIn(OPERATOR, { operator: true });
    const shops = (html: string) => text(html).match(/Shop \d{2}/g) ?? [];

    const first = await operator.get("/admin/merchants");
    const second = await operator.get("/admin/merchants?page=2");
    const past = await operator.get("/admin/merchants?page=9");

    // The channel holds the operator's own merchant besides the shops.
    const of = Number(/Showing 1–50 of (\d+)/.exec(text(first.html))?.[1]);
    expect(of).toBeGreaterThan(50);
    expect(first.html).toMatch(/href="[^"]*\/admin\/merchants\?page=2"/);
    expect(text(second.html)).toContain(`Showing 51–${of} of ${of}`);
    expect([...shops(first.html), ...shops(second.html)].sort()).toStrictEqual(
      Array.from({ length: 52 }, (_, at) => `Shop ${String(at).padStart(2, "0")}`),
    );
    expect(shops(past.html)).toStrictEqual(shops(second.html));
  });

  it("answers anybody without the operator flag as a page that is not there", async () => {
    served = await adminServed();
    const merchant = await served.signedIn("owner@shop.example");

    expect((await merchant.get("/admin/merchants")).status).toBe(404);
  });
});

describe("a merchant's page", () => {
  it("is not there for a merchant that does not exist", async () => {
    served = await adminServed();
    const operator = await served.signedIn(OPERATOR, { operator: true });

    expect((await operator.get("/admin/merchants/mch_nobody")).status).toBe(404);
  });

  it("says a wallet change waits, but never shows the waiting wallet or its split", async () => {
    served = await adminServed({ channel: "live" });
    const { harnessed } = served;
    const merchant = await harnessed.addMerchant("Coffee Roasters");
    const operator = await served.signedIn(OPERATOR, { operator: true });
    const network = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:8453");
    const now = await harnessed.store.merchantById(merchant.id);
    const paid = now?.payoutWallet.address ?? "";
    const waiting = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
    const waitingSplit = payoutSplitFor(network, merchant.id, waiting);
    const written = await harnessed.store.setPayoutWallet(
      merchant.id,
      now?.payoutWallet ?? { address: null, pending: null },
      {
        address: paid,
        split: payoutSplitFor(network, merchant.id, paid),
        pending: {
          address: waiting,
          // On the clock the workspace reads, which is the dashboard's own.
          takesEffectAt: Date.now() + 48 * 3_600_000,
          split: waitingSplit,
        },
      },
      harnessed.now(),
    );
    expect(typeof written).toBe("object");

    const page = await operator.get(`/admin/merchants/${merchant.id}`);

    expect(page.status).toBe(200);
    const said = text(page.html);
    expect(said).toContain("Coffee Roasters, as buyers and their agents read it");
    expect(said).toContain("Pays out from the split");
    expect(said).toContain("A change of wallet waits and lands");
    for (const hidden of [waiting, waitingSplit.address]) {
      expect(page.html.toLowerCase()).not.toContain(hidden.toLowerCase().slice(2));
    }
  });

  it("answers a press without the operator flag as no such page, changing nothing", async () => {
    served = await adminServed({ channel: "live" });
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    const somebody = await served.signedIn("owner@shop.example");

    const pressed = await somebody.post(`/admin/merchants/${merchant.id}/withdraw`, {
      ...TICKED,
      [REASON_FIELD]: "a reason",
    });

    expect(pressed.status).toBe(404);
    expect(await served.harnessed.gateway.liveApproved(merchant.id)).toBe(true);
    expect(await rowsAbout(served, merchant.id)).toStrictEqual([]);
  });
});

describe("withdrawing and giving the admission", () => {
  it("withdraws with the note the merchant reads, takes the cards off sale, and admits again", async () => {
    served = await adminServed({ channel: "live" });
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    const operator = await served.signedIn(OPERATOR, { operator: true });
    const path = `/admin/merchants/${merchant.id}`;
    const note = "The seller name copies another shop's; choose your own and write to us.";

    const withdrawn = await operator.post(`${path}/withdraw`, {
      ...TICKED,
      [REASON_FIELD]: note,
    });

    expect(withdrawn.status).toBe(200);
    expect(await served.harnessed.gateway.liveApproved(merchant.id)).toBe(false);
    expect(text(withdrawn.html)).toContain(`The merchant reads: “${note}”`);
    expect((await served.harnessed.store.standingWithdrawal(merchant.id))?.reason).toBe(note);
    // What the merchant reads on their own dashboard while it stands.
    await served.identity.make("owner@coffee.example", merchant.id);
    const own = await served.signedIn("owner@coffee.example");
    const banner = text((await own.get("/cards")).html);
    expect(banner).toContain("Live sales are stopped");
    expect(banner).toContain(`“${note}”`);

    const admitted = await operator.post(`${path}/admit`, { ...TICKED });
    const again = await operator.post(`${path}/admit`, { ...TICKED });

    expect([admitted.status, again.status]).toStrictEqual([200, 200]);
    expect(await served.harnessed.gateway.liveApproved(merchant.id)).toBe(true);
    expect(text(again.html)).toContain("It was so already");
    // The history names who acted by their address, to them and to another operator.
    const second = await served.signedIn("op2@agentify.example", { operator: true });
    for (const reader of [operator, second]) {
      const history = text((await reader.get(path)).html).split("History")[1] ?? "";
      expect(history).toContain(OPERATOR);
    }
    expect(
      (await rowsAbout(served, merchant.id)).map((row) => [row.action, row.outcome.kind]),
    ).toStrictEqual([
      ["admit", "unchanged"],
      ["admit", "done"],
      ["withdraw", "done"],
    ]);
  });

  it("changes nothing without a fresh sign-in, and asks for one in place", async () => {
    served = await adminServed({ channel: "live" });
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    const operator = await served.signedIn(OPERATOR, { operator: true });
    served.ageSessions(16 * 60 * 1000);

    const pressed = await operator.post(`/admin/merchants/${merchant.id}/withdraw`, {
      ...TICKED,
      [REASON_FIELD]: "a reason",
    });

    expect(await served.harnessed.gateway.liveApproved(merchant.id)).toBe(true);
    expect(text(pressed.html)).toContain("Confirm it");
    expect((await rowsAbout(served, merchant.id)).map((row) => row.outcome)).toStrictEqual([
      { kind: "refused", code: "sign_in_not_fresh" },
    ]);
  });

  it("refuses a withdrawal without a note by asking for the note, or with the box left unticked, changing nothing", async () => {
    served = await adminServed({ channel: "live" });
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    const operator = await served.signedIn(OPERATOR, { operator: true });
    const path = `/admin/merchants/${merchant.id}`;

    const noNote = await operator.post(`${path}/withdraw`, {
      ...TICKED,
      [REASON_FIELD]: " ",
    });
    const unticked = await operator.post(`${path}/withdraw`, { [REASON_FIELD]: "a reason" });

    expect([noNote.status, unticked.status]).toStrictEqual([409, 409]);
    expect(text(noNote.html)).toContain(WITHDRAWAL_NOTE.missing);
    expect(text(unticked.html)).toContain("Tick the box");
    expect(await served.harnessed.gateway.liveApproved(merchant.id)).toBe(true);
  });

  it("refuses an admission off the live channel, which asks none, and shows no admission there", async () => {
    served = await adminServed({ channel: "test" });
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    const operator = await served.signedIn(OPERATOR, { operator: true });
    const path = `/admin/merchants/${merchant.id}`;

    const page = await operator.get(path);
    const pressed = await operator.post(`${path}/admit`, { ...TICKED });

    expect(text(page.html)).not.toContain("Admission to live sales");
    expect(pressed.status).toBe(409);
    expect(await served.harnessed.gateway.liveApproved(merchant.id)).toBe(false);
    expect((await rowsAbout(served, merchant.id)).map((row) => row.outcome)).toStrictEqual([
      { kind: "refused", code: "not_live_channel" },
    ]);
  });
});

describe("disabling a merchant's key", () => {
  it("stops that key alone with its reason, a repeat changing nothing", async () => {
    served = await adminServed();
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    const other = await served.harnessed.addKey(merchant.id, "second");
    void other;
    const operator = await served.signedIn(OPERATOR, { operator: true });
    const path = `/admin/merchants/${merchant.id}`;
    const press = { ...TICKED, [REASON_FIELD]: "it leaked" };

    const first = await operator.post(`${path}/keys/${merchant.keyId}/disable`, press);
    const again = await operator.post(`${path}/keys/${merchant.keyId}/disable`, press);

    expect([first.status, again.status]).toStrictEqual([200, 200]);
    // The answer drawn is the one its row holds: done, then already so.
    expect(text(first.html)).toContain("Disabled just now");
    expect(text(again.html)).not.toContain("Disabled just now");
    const keys = await served.harnessed.store.keysOf(merchant.id);
    expect(keys.filter((key) => key.disabledAt !== null).map((key) => key.id)).toStrictEqual([
      merchant.keyId,
    ]);
    expect(keys.filter((key) => key.disabledAt === null)).toHaveLength(1);
    expect(
      (await rowsAbout(served, merchant.id)).map((row) => [row.subject.id, row.outcome.kind]),
    ).toStrictEqual([
      [merchant.keyId, "unchanged"],
      [merchant.keyId, "done"],
    ]);
  });

  it("answers a repeat in the same millisecond as already so, as its row says", async () => {
    served = await adminServed();
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    const operator = await served.signedIn(OPERATOR, { operator: true });
    const path = `/admin/merchants/${merchant.id}/keys/${merchant.keyId}/disable`;
    const press = { ...TICKED, [REASON_FIELD]: "it leaked" };
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });

    const first = await operator.post(path, press);
    const again = await operator.post(path, press);

    expect(text(first.html)).toContain("Disabled just now");
    expect(text(again.html)).not.toContain("Disabled just now");
    expect((await rowsAbout(served, merchant.id)).map((row) => row.outcome.kind)).toStrictEqual([
      "unchanged",
      "done",
    ]);
  });

  it("refuses another merchant's key as not this merchant's, and leaves it working", async () => {
    served = await adminServed();
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    const stranger = await served.harnessed.addMerchant("Another Shop");
    const operator = await served.signedIn(OPERATOR, { operator: true });

    const pressed = await operator.post(
      `/admin/merchants/${merchant.id}/keys/${stranger.keyId}/disable`,
      {
        ...TICKED,
        [REASON_FIELD]: "it leaked",
      },
    );

    expect(pressed.status).toBe(409);
    expect(text(pressed.html)).toContain("That key is not one of this merchant's");
    expect((await served.harnessed.store.keysOf(stranger.id))[0]?.disabledAt).toBeNull();
  });
});

describe("a merchant's history", () => {
  it("says each press with the Journal's verbs, done or changing nothing", async () => {
    served = await adminServed({ channel: "live" });
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    const operator = await served.signedIn(OPERATOR, { operator: true });
    const path = `/admin/merchants/${merchant.id}`;
    const withReason = { ...TICKED, [REASON_FIELD]: "it leaked" };
    for (const pressed of ["withdraw", "withdraw", "admit", "admit"]) {
      await operator.post(`${path}/${pressed}`, withReason);
    }
    await operator.post(`${path}/keys/${merchant.keyId}/disable`, withReason);
    await operator.post(`${path}/keys/${merchant.keyId}/disable`, withReason);

    const history = text((await operator.get(path)).html);
    const journal = text((await operator.get("/admin/journal")).html);

    for (const verb of [
      "Withdrew the admission",
      "Asked to withdraw the admission",
      "Admitted",
      "Asked to admit",
      "Disabled the key",
      "Asked to disable the key",
    ]) {
      expect(history).toContain(verb);
      expect(journal).toContain(verb);
    }
  });
});

describe("a press whose page cannot be read again", () => {
  it("is answered as done, saying the page could not be read again, rather than as a broken page", async () => {
    // The change committed with its journal row; a page drawn as broken would
    // send the operator to press again on a change already made.
    let reads = 0;
    served = await adminServed({
      channel: "live",
      reader: (real) => ({
        ...real,
        merchants: {
          ...real.merchants,
          merchant: async () => {
            reads += 1;
            throw new Error("the database is not answering");
          },
        },
      }),
    });
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    const operator = await served.signedIn(OPERATOR, { operator: true });

    expect((await served.harnessed.store.merchantById(merchant.id))?.liveApprovedAt).not.toBeNull();

    const pressed = await operator.post(`/admin/merchants/${merchant.id}/withdraw`, {
      ...TICKED,
      [REASON_FIELD]: "it leaked",
    });

    expect(reads).toBe(1);
    expect(pressed.status).toBe(200);
    expect(text(pressed.html)).toContain("Withdrew the admission.");
    expect(text(pressed.html)).toContain("could not be read again");
    expect(text(pressed.html)).not.toContain("Something went wrong");
    expect((await served.harnessed.store.merchantById(merchant.id))?.liveApprovedAt).toBeNull();
  });
});

describe("a merchant's uncertain shop orders", () => {
  const failing = async (): Promise<never> => {
    throw new Error("the database is not answering");
  };

  /** The page's view of a merchant with one order worth a look, over parts whose accounts or shops fail as the case says. */
  const viewWith = async (fails: "accounts" | "shop" | "nothing") => {
    served = await adminServed();
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    await served.identity.make("owner@coffee.example", merchant.id);
    const real = memoryOperatorReader(served.harnessed.store);
    const reader: OperatorReader = {
      ...real,
      merchants: {
        ...real.merchants,
        merchant: async (id, asked) => {
          const record = await real.merchants.merchant(id, asked);
          return record === null
            ? null
            : {
                ...record,
                worthALook: {
                  rows: [
                    {
                      id: "ord_8c2e5d07a3f141a9",
                      status: "payment_unresolved",
                      price: { amount: "24.00", currency: "USD" },
                      createdAt: Date.now() - 60_000,
                      itemId: "itm_old_town",
                      title: null,
                    },
                  ],
                  total: 1,
                },
              };
        },
      },
    };
    const identity = served.identity;
    const pages = merchantsFor({
      config: served.config,
      gateway: served.harnessed.gateway,
      reader,
      identity:
        fails === "accounts"
          ? ({ ...identity, accountsNamed: failing } as unknown as AdminParts["identity"])
          : identity,
      shops: { ...memoryWooShops(), ...(fails === "shop" ? { connectionOf: failing } : {}) },
      now: () => new Date(),
    } as unknown as AdminParts);
    const answered = await pages.one({ person: { id: "acc_op" } } as Operator, merchant.id);
    return answered.kind === "view" ? answered.view : null;
  };

  it("are said to be unread where the merchant's accounts could not be read, never drawn as none", async () => {
    expect((await viewWith("accounts"))?.shopOrdersUnread).toBe(true);
  });

  it("are said to be unread where the merchant's shop record could not be read, never drawn as none", async () => {
    expect((await viewWith("shop"))?.shopOrdersUnread).toBe(true);
  });

  it("are not said to be unread where everything was read", async () => {
    expect((await viewWith("nothing"))?.shopOrdersUnread).toBe(false);
  });
});
