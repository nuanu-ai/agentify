/**
 * What every administrative press goes through, whatever the action. If these
 * fail, an action could go ahead on a stale session, without its consequence
 * ticked or its reason written, or a refused press could leave no trace in the
 * journal, or a lost answer could be said as done.
 */

import { MemoryStore } from "@agentify/gateway";
import type { JournalEntry, JournalPress } from "@agentify/gateway/journal";
import { describe, expect, it } from "vitest";
import type { Person } from "../dashboard-entry.js";
import { FRESH_SIGN_IN_MS, type Operator } from "./access.js";
import { type ChangeAnswer, type Press, pressed } from "./action.js";
import { memoryJournal } from "./journal.js";
import { LOST_ANSWER, NO_REASON, NOT_CONFIRMED } from "./words.js";

const NOW = new Date("2026-10-23T12:00:00Z");
const PERSON: Person = {
  id: "acc_operator",
  email: "operator@example.com",
  confirmed: true,
  merchant: null,
};

/** An operator as the workspace's check makes one, signed in `ago` before now. */
const operatorSignedIn = (ago: number): Operator =>
  ({ person: PERSON, signedInAt: new Date(NOW.getTime() - ago) }) as Operator;

const formOf = (fields: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return form;
};

const withdrawal = (fields: Record<string, string>, ago = 60_000): Press => ({
  operator: operatorSignedIn(ago),
  form: formOf(fields),
  action: "withdraw",
  subject: { kind: "merchant", id: "mch_a" },
  needsReason: true,
  destination: "admin/merchants/mch_a",
});

const setUp = () => {
  const store = new MemoryStore("eip155:84532", () => "id");
  const changes: JournalPress[] = [];
  const pressing = {
    now: () => NOW,
    googleEnabled: true,
    refused: (entry: JournalEntry) => store.recordJournal(entry),
  };
  const change =
    (answer: ChangeAnswer | Error = { kind: "done" }) =>
    async (journal: JournalPress): Promise<ChangeAnswer> => {
      changes.push(journal);
      if (answer instanceof Error) throw answer;
      return answer;
    };
  const rows = async () => (await store.journal({ limit: 50 })).rows;
  return { store, changes, pressing, change, rows };
};

const READY = { confirm: "yes", reason: "The seller asked us to stop their sales" };

describe("an administrative press", () => {
  it("goes ahead with a fresh sign-in, the box ticked and a reason, handing the change its journal row", async () => {
    const { pressing, change, changes } = setUp();

    expect(await pressed(withdrawal(READY), pressing, change())).toStrictEqual({ kind: "done" });

    expect(changes).toStrictEqual([
      {
        at: NOW.getTime(),
        actor: { kind: "account", id: PERSON.id },
        action: "withdraw",
        subject: { kind: "merchant", id: "mch_a" },
        reason: READY.reason,
      },
    ]);
  });

  it("asks for a fresh sign-in after fifteen minutes, changes nothing and journals the refusal", async () => {
    const { pressing, change, changes, rows } = setUp();

    const answered = await pressed(withdrawal(READY, FRESH_SIGN_IN_MS), pressing, change());

    expect(answered).toMatchObject({
      kind: "step-up",
      stepUp: {
        email: PERSON.email,
        destination: "admin/merchants/mch_a",
        googleEnabled: true,
        link: null,
      },
    });
    expect(changes).toStrictEqual([]);
    expect((await rows()).map((row) => row.outcome)).toStrictEqual([
      { kind: "refused", code: "sign_in_not_fresh" },
    ]);
  });

  it("hands back the reason as it was typed when it asks for a fresh sign-in or refuses the press", async () => {
    // The operator typed it before pressing; a step-up or a refusal that drops
    // it makes them write it again from memory.
    const { pressing, change } = setUp();

    expect(await pressed(withdrawal(READY, FRESH_SIGN_IN_MS), pressing, change())).toMatchObject({
      kind: "step-up",
      typed: READY.reason,
    });
    expect(await pressed(withdrawal({ reason: READY.reason }), pressing, change())).toMatchObject({
      kind: "refused",
      typed: READY.reason,
    });
    expect(
      await pressed(withdrawal({ confirm: "yes", reason: "<b>stop</b>" }), pressing, change()),
    ).toMatchObject({ kind: "refused", typed: "<b>stop</b>", field: "reason" });
    expect(
      await pressed(withdrawal({ confirm: "yes", reason: "  " }), pressing, change()),
    ).toMatchObject({ kind: "refused", field: "reason" });
  });

  it("refuses a press whose consequence is not ticked, or ticked twice", async () => {
    const { pressing, change, changes, rows } = setUp();

    const unticked: Record<string, string>[] = [
      { reason: READY.reason },
      { reason: READY.reason, confirm: "on" },
    ];
    for (const fields of unticked) {
      expect(await pressed(withdrawal(fields), pressing, change())).toMatchObject({
        kind: "refused",
        said: NOT_CONFIRMED,
      });
    }
    const twice = withdrawal(READY);
    twice.form.append("confirm", "yes");
    expect((await pressed(twice, pressing, change())).kind).toBe("refused");

    expect(changes).toStrictEqual([]);
    expect((await rows()).map((row) => row.outcome)).toStrictEqual(
      Array(3).fill({ kind: "refused", code: "not_confirmed" }),
    );
  });

  it("refuses an intervention with no reason, or one the journal cannot keep", async () => {
    const { pressing, change, changes, rows } = setUp();

    expect(
      await pressed(withdrawal({ confirm: "yes", reason: "   " }), pressing, change()),
    ).toMatchObject({ kind: "refused", said: NO_REASON });
    const markup = await pressed(
      withdrawal({ confirm: "yes", reason: "<b>stop</b>" }),
      pressing,
      change(),
    );
    expect(markup).toMatchObject({
      kind: "refused",
      said: expect.stringContaining("Nothing was changed"),
    });

    expect(changes).toStrictEqual([]);
    expect((await rows()).map((row) => row.outcome)).toStrictEqual([
      { kind: "refused", code: "reason_refused" },
      { kind: "refused", code: "no_reason" },
    ]);
  });

  it("keeps no reason for an action that asks for none", async () => {
    const { pressing, change, changes } = setUp();
    const admission: Press = { ...withdrawal(READY), action: "admit", needsReason: false };

    await pressed(admission, pressing, change());

    expect(changes[0]?.reason).toBeNull();
  });

  it("says a lost answer is unknown and writes no row of its own", async () => {
    const { pressing, change, rows } = setUp();

    expect(
      await pressed(withdrawal(READY), pressing, change(new Error("the line dropped"))),
    ).toStrictEqual({ kind: "unknown" });
    expect(await rows()).toStrictEqual([]);
    expect(LOST_ANSWER).toContain("Pressing again is safe");
  });

  it("journals the change's own refusal with its code and the reason given", async () => {
    const { pressing, change, rows } = setUp();

    const answered = await pressed(
      withdrawal(READY),
      pressing,
      change({ kind: "refused", code: "no_such_merchant", said: "There is no such merchant." }),
    );

    expect(answered).toMatchObject({ kind: "refused", said: "There is no such merchant." });
    expect(await rows()).toMatchObject([
      { outcome: { kind: "refused", code: "no_such_merchant" }, reason: READY.reason },
    ]);
  });

  it("passes an unchanged answer on, as the store settled it", async () => {
    const { pressing, change } = setUp();

    expect(await pressed(withdrawal(READY), pressing, change({ kind: "unchanged" }))).toStrictEqual(
      {
        kind: "unchanged",
      },
    );
  });
});

describe("a dashboard action's change and its row", () => {
  const ENDED: JournalPress = {
    at: NOW.getTime(),
    actor: { kind: "account", id: PERSON.id },
    action: "end_sessions",
    subject: { kind: "account", id: "acc_someone" },
    reason: "A stolen laptop",
  };

  it("are written together, done or unchanged as the change settles it", async () => {
    const store = new MemoryStore("eip155:84532", () => "id");
    const journal = memoryJournal(store);

    expect(await journal.along(ENDED, async () => ({ result: 3, changed: true }))).toBe(3);
    await journal.along(ENDED, async () => ({ result: 0, changed: false }));

    expect((await store.journal({ limit: 10 })).rows.map((row) => row.outcome)).toStrictEqual([
      { kind: "unchanged" },
      { kind: "done" },
    ]);
  });

  it("refuses a change whose row the journal refuses before the change runs", async () => {
    const store = new MemoryStore("eip155:84532", () => "id");
    const journal = memoryJournal(store);
    let ran = false;

    await expect(
      journal.along({ ...ENDED, reason: "<b>no</b>" }, async () => {
        ran = true;
        return { result: 1, changed: true };
      }),
    ).rejects.toThrow();

    expect(ran).toBe(false);
    expect((await store.journal({ limit: 10 })).total).toBe(0);
  });

  it("writes no row for a change that failed or found nothing to act on", async () => {
    const store = new MemoryStore("eip155:84532", () => "id");
    const journal = memoryJournal(store);

    await expect(
      journal.along(ENDED, async () => {
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    expect(await journal.along(ENDED, async () => ({ result: 0, changed: null }))).toBe(0);

    expect((await store.journal({ limit: 10 })).total).toBe(0);
  });
});
