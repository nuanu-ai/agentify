/**
 * Accounts, one account's actions and the Journal over HTTP, as an operator
 * meets them: who is listed and who only counted, what each action changes
 * and writes to the journal, what it refuses and in which words, the mail a
 * change of the operator flag waits for, and the first operator a channel's
 * configuration names. If these fail, an operator could act on an account
 * without a record, lock a channel out of its own workspace, or read a list
 * that claims more than it holds.
 */

import type { Receipt } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { type AdminServed, adminServed } from "../testing/admin.js";
import { readable } from "../testing/html.js";

const OPERATOR = "operator@example.com";
const SECOND = "second@example.com";
const MERCHANT = "owner@example.com";
const READER = "reader@example.com";
const REASON = "The owner reported a lost laptop";

let served: AdminServed | null = null;
const serve = async (options?: Parameters<typeof adminServed>[0]) => {
  served = await adminServed(options);
  return served;
};

afterEach(async () => {
  await served?.close();
  served = null;
});

const idOf = async (workspace: AdminServed, email: string): Promise<string> => {
  const person = await workspace.identity.byEmail(email);
  if (person === null) throw new Error(`no account for ${email}`);
  return person.id;
};

const rowsOf = async (workspace: AdminServed) =>
  (await workspace.harnessed.store.journal({ limit: 50 })).rows.map((row) => ({
    action: row.action,
    outcome: row.outcome.kind === "refused" ? row.outcome.code : row.outcome.kind,
    reason: row.reason,
  }));

const sessionsOf = (workspace: AdminServed, id: string): number =>
  (workspace.rows.dashboard_sessions ?? []).filter((row) => row.userId === id).length;

const asOperator = { confirm: "yes", reason: REASON };

describe("Accounts", () => {
  it("lists the accounts with a merchant or the flag, counts the rest, and finds one by its whole address", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(MERCHANT);
    await workspace.identity.make(READER, "mch_placeholder");
    await workspace.identity.setOperator(READER, false);
    // An account that only signed in names no merchant.
    workspace.rows.dashboard_accounts = (workspace.rows.dashboard_accounts ?? []).map((row) =>
      row.email === READER ? { ...row, merchantId: null } : row,
    );

    const page = readable((await operator.get("/admin/accounts")).html);

    expect(page).toContain(OPERATOR);
    expect(page).toContain(MERCHANT);
    expect(page).not.toContain(READER);
    expect(page).toContain("1 more account only signed in");
    expect(page).toMatch(/Operators\s*1/);
    // The test's sign-in makes every account a merchant first, the operator's too.
    expect(page).toMatch(/With a merchant\s*2/);

    const found = readable((await operator.get(`/admin/accounts?q=${READER}`)).html);
    expect(found).toContain(READER);
    const partly = readable((await operator.get("/admin/accounts?q=reader")).html);
    expect(partly).not.toContain(READER);
  });

  it("shows an operator's segment alone, and says so where a search matches nothing", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(MERCHANT);

    const operators = readable((await operator.get("/admin/accounts?show=operators")).html);
    expect(operators).toContain(OPERATOR);
    expect(operators).not.toContain(MERCHANT);

    const nothing = readable((await operator.get("/admin/accounts?q=nobody-here")).html);
    expect(nothing).toContain("No listed account matches “nobody-here”");
  });
});

describe("ending every session of an account", () => {
  it("signs the person out everywhere, keeps the account, and writes the row with its reason", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(MERCHANT);
    const account = await idOf(workspace, MERCHANT);
    expect(sessionsOf(workspace, account)).toBe(1);

    const pressed = await operator.post(`/admin/accounts/${account}/end-sessions`, asOperator);

    expect(pressed.status).toBe(200);
    expect(readable(pressed.html)).toContain(`Ended every session of ${MERCHANT}`);
    expect(sessionsOf(workspace, account)).toBe(0);
    expect(await workspace.identity.byEmail(MERCHANT)).not.toBeNull();
    expect(await rowsOf(workspace)).toStrictEqual([
      { action: "end_sessions", outcome: "done", reason: REASON },
    ]);
    // The page drawn after the press holds the row that recorded it.
    expect(readable(pressed.html)).toContain(`Reason: ${REASON}`);

    const again = await operator.post(`/admin/accounts/${account}/end-sessions`, asOperator);
    expect(readable(again.html)).toContain("had no session open");
    expect((await rowsOf(workspace))[0]?.outcome).toBe("unchanged");
  });

  it("refuses a press without a reason or without the box ticked, changing nothing", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(MERCHANT);
    const account = await idOf(workspace, MERCHANT);

    const unreasoned = await operator.post(`/admin/accounts/${account}/end-sessions`, {
      confirm: "yes",
    });
    const unticked = await operator.post(`/admin/accounts/${account}/end-sessions`, {
      reason: REASON,
    });

    expect(readable(unreasoned.html)).toContain("Write the reason");
    expect(readable(unticked.html)).toContain("Tick the box");
    expect(sessionsOf(workspace, account)).toBe(1);
    expect((await rowsOf(workspace)).map((row) => row.outcome)).toStrictEqual([
      "not_confirmed",
      "no_reason",
    ]);
  });

  it("refuses an account that is not there, in words, and records the refusal", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });

    const pressed = await operator.post("/admin/accounts/acc_gone/end-sessions", asOperator);

    expect(readable(pressed.html)).toContain("No account has that identifier");
    expect((await rowsOf(workspace))[0]?.outcome).toBe("no_such_account");
  });

  it("says the outcome is unknown where the change's answer was lost", async () => {
    const workspace = await serve({
      identity: (real: Identity): Identity => ({
        ...real,
        endSessionsIn: async () => {
          throw new Error("the connection dropped");
        },
      }),
    });
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(MERCHANT);
    const account = await idOf(workspace, MERCHANT);

    const pressed = await operator.post(`/admin/accounts/${account}/end-sessions`, asOperator);

    expect(readable(pressed.html)).toContain("The outcome is unknown");
    expect(readable(pressed.html)).toContain("pressing again is safe");
  });
});

describe("the operator flag", () => {
  it("grants the flag once every operator and the account were mailed, and writes the row", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(SECOND, { operator: true });
    await workspace.signedIn(MERCHANT);
    const account = await idOf(workspace, MERCHANT);
    const before = workspace.mails.length;

    const pressed = await operator.post(`/admin/accounts/${account}/grant-operator`, asOperator);

    expect(readable(pressed.html)).toContain(`Made ${MERCHANT} an operator`);
    expect(
      workspace.mails
        .slice(before)
        .map((mail) => mail.to)
        .sort(),
    ).toStrictEqual([OPERATOR, MERCHANT, SECOND]);
    expect(workspace.mails.at(-1)?.body).toContain(`signed in as ${OPERATOR}`);
    expect((await workspace.identity.operatorAccount(account, new Date()))?.operator).toBe(true);
    expect((await rowsOf(workspace))[0]).toStrictEqual({
      action: "grant_operator",
      outcome: "done",
      reason: REASON,
    });
  });

  it("leaves the flag as it was where the mail is not handed over, and says so", async () => {
    const workspace = await serve({
      handOver: (message) => (message.subject.includes("operator") ? "refused" : "accepted"),
    });
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(MERCHANT);
    const account = await idOf(workspace, MERCHANT);

    const pressed = await operator.post(`/admin/accounts/${account}/grant-operator`, asOperator);

    expect(readable(pressed.html)).toContain("was not handed to the provider");
    expect((await workspace.identity.operatorAccount(account, new Date()))?.operator).toBe(false);
    expect((await rowsOf(workspace))[0]?.outcome).toBe("mail_not_handed");
  });

  it("removes another operator's flag, and never the last one's", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(SECOND, { operator: true });
    const second = await idOf(workspace, SECOND);
    const mine = await idOf(workspace, OPERATOR);

    const removed = await operator.post(`/admin/accounts/${second}/remove-operator`, asOperator);
    expect(readable(removed.html)).toContain(`Removed the operator flag of ${SECOND}`);

    const own = readable((await operator.get(`/admin/accounts/${mine}`)).html);
    expect(own).toContain("The last operator's flag cannot be removed");
    expect(own).not.toContain("Remove the flag");
    const pressedAnyway = await operator.post(
      `/admin/accounts/${mine}/remove-operator`,
      asOperator,
    );
    expect(readable(pressedAnyway.html)).toContain("It is the channel's last operator");
    expect((await workspace.identity.operatorAccount(mine, new Date()))?.operator).toBe(true);
    expect((await rowsOf(workspace)).map((row) => row.outcome)).toStrictEqual([
      "last_operator",
      "done",
    ]);
  });

  it("gives the configured first operator the flag at their sign-in, as the configuration's", async () => {
    const workspace = await serve({ environment: { FIRST_OPERATOR_EMAIL: OPERATOR } });

    const first = await workspace.signedIn(OPERATOR, { operator: false });

    // The test's sign-in sets the flag it is asked for before signing in, so
    // the flag here is the configuration's.
    expect((await first.get("/admin/accounts")).status).toBe(200);
    const rows = (await workspace.harnessed.store.journal({ limit: 5 })).rows;
    expect(rows.map((row) => [row.action, row.actor.kind])).toStrictEqual([
      ["first_operator", "configuration"],
    ]);
  });
});

describe("forgetting an account", () => {
  it("is offered on the test channel, and removes the account so it signs in as a newcomer", async () => {
    const workspace = await serve({ channel: "test" });
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(MERCHANT);
    const account = await idOf(workspace, MERCHANT);
    expect(readable((await operator.get(`/admin/accounts/${account}`)).html)).toContain(
      "Forget this account",
    );

    const pressed = await operator.post(`/admin/accounts/${account}/forget`, asOperator);

    expect(readable(pressed.html)).toContain("signs in again as a newcomer");
    expect(await workspace.identity.byEmail(MERCHANT)).toBeNull();
    expect((await rowsOf(workspace))[0]).toMatchObject({
      action: "forget_account",
      outcome: "done",
    });
    const journal = readable((await operator.get("/admin/journal")).html);
    expect(journal).toContain("Forgot the account");
    // Its rows keep its identifier, by which it is still searched.
    const byId = readable((await operator.get(`/admin/journal?q=${account}`)).html);
    expect(byId).toContain("Forgot the account");
    const byAddress = readable((await operator.get(`/admin/journal?q=${MERCHANT}`)).html);
    expect(byAddress).toContain("A forgotten account is searched by its identifier");
  });

  it("is neither offered nor done on the live channel", async () => {
    const workspace = await serve({ channel: "live" });
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(MERCHANT);
    const account = await idOf(workspace, MERCHANT);
    expect(readable((await operator.get(`/admin/accounts/${account}`)).html)).not.toContain(
      "Forget this account",
    );

    const pressed = await operator.post(`/admin/accounts/${account}/forget`, asOperator);

    expect(readable(pressed.html)).toContain("only on the test channel");
    expect(await workspace.identity.byEmail(MERCHANT)).not.toBeNull();
  });

  it("is refused while the merchant has a receipt, and for the last operator", async () => {
    const workspace = await serve({ channel: "test" });
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(MERCHANT);
    const account = await idOf(workspace, MERCHANT);
    const merchant = (await workspace.identity.byEmail(MERCHANT))?.merchant?.id ?? "";
    await workspace.harnessed.store.putReceipt(merchant, { order_id: "ord_kept" } as Receipt);

    const page = readable((await operator.get(`/admin/accounts/${account}`)).html);
    expect(page).toContain("0 orders and 1 receipt, which are never deleted");
    const pressed = await operator.post(`/admin/accounts/${account}/forget`, asOperator);
    expect(readable(pressed.html)).toContain("The merchant has orders or receipts");
    expect(await workspace.identity.byEmail(MERCHANT)).not.toBeNull();

    const mine = await idOf(workspace, OPERATOR);
    expect(readable((await operator.get(`/admin/accounts/${mine}`)).html)).toContain(
      "The last operator's account cannot be forgotten",
    );
    const own = await operator.post(`/admin/accounts/${mine}/forget`, asOperator);
    expect(readable(own.html)).toContain("It is the channel's last operator");
    expect(await workspace.identity.byEmail(OPERATOR)).not.toBeNull();
  });
});

describe("the Journal", () => {
  it("lists every action newest first, naming who acted, filtered by kind and searched by address", async () => {
    const workspace = await serve();
    const operator = await workspace.signedIn(OPERATOR, { operator: true });
    await workspace.signedIn(MERCHANT);
    await workspace.signedIn(SECOND);
    const merchant = await idOf(workspace, MERCHANT);
    const second = await idOf(workspace, SECOND);
    await operator.post(`/admin/accounts/${merchant}/end-sessions`, asOperator);
    await operator.post(`/admin/accounts/${second}/grant-operator`, asOperator);

    const all = readable((await operator.get("/admin/journal")).html);
    expect(all.indexOf(`Made ${SECOND} an operator`)).toBeLessThan(
      all.indexOf(`Ended every session of ${MERCHANT}`),
    );
    expect(all).toContain(OPERATOR);
    expect(all).toContain("2 of 2 shown");

    const sessions = readable((await operator.get("/admin/journal?kind=sessions")).html);
    expect(sessions).toContain(`Ended every session of ${MERCHANT}`);
    expect(sessions).not.toContain(`Made ${SECOND} an operator`);

    const searched = readable((await operator.get(`/admin/journal?q=${SECOND}`)).html);
    expect(searched).toContain(`Made ${SECOND} an operator`);
    expect(searched).not.toContain(`Ended every session of ${MERCHANT}`);

    const unsearchable = readable((await operator.get("/admin/journal?q=lost laptop")).html);
    expect(unsearchable).toContain("The journal is searched by a merchant's identifier");
  });
});
