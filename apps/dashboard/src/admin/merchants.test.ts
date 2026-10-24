/**
 * The workspace's Merchants list and a merchant's page over HTTP, as an
 * operator meets them: what they show, and what each press on a merchant
 * changes, records and refuses. Each case names the promise to the operator
 * or to the merchant that breaks when it fails.
 */

import { afterEach, describe, expect, it } from "vitest";
import { type AdminServed, adminServed } from "../testing/admin.js";
import { CONFIRM_FIELD, CONFIRMED, REASON_FIELD } from "./fields.js";

let served: AdminServed | null = null;

afterEach(async () => {
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

  it("shows the wallet whole and its split, but never a waiting wallet's split", async () => {
    served = await adminServed({ channel: "live" });
    const merchant = await served.harnessed.addMerchant("Coffee Roasters");
    const operator = await served.signedIn(OPERATOR, { operator: true });

    const page = await operator.get(`/admin/merchants/${merchant.id}`);

    expect(page.status).toBe(200);
    const said = text(page.html);
    expect(said).toContain("Coffee Roasters, as buyers and their agents read it");
    expect(said).toContain("Pays out from the split");
    expect(said).toContain("No change of wallet waits.");
    expect(said).toContain("Admitted");
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

    const admitted = await operator.post(`${path}/admit`, { ...TICKED });
    const again = await operator.post(`${path}/admit`, { ...TICKED });

    expect([admitted.status, again.status]).toStrictEqual([200, 200]);
    expect(await served.harnessed.gateway.liveApproved(merchant.id)).toBe(true);
    expect(text(again.html)).toContain("It was so already");
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

  it("refuses a withdrawal without a note, or with the box left unticked, changing nothing", async () => {
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
    expect(text(noNote.html)).toContain("Write the reason");
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
