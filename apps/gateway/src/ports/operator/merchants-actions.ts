/**
 * The gateway's half of the three actions an operator takes on a merchant:
 * admit to live sales, withdraw the admission and disable a key. The
 * admission is the one lever the operator holds over a merchant's selling;
 * the operator never sets or takes away the name a merchant chose. The caller has already confirmed the operator flag; from here
 * every press leaves exactly one row in the operator's journal. A change and
 * its row commit together in the store's transaction, done where the press
 * changed something and unchanged where it found the change made; a refusal
 * changes nothing and writes its row on its own.
 *
 * Each answers with the outcome its row holds. A press whose answer is lost
 * may have committed; pressing again is safe, since every action is
 * idempotent and a repeat is recorded as unchanged.
 */

import type { SurfaceMode } from "@agentify/core";
import { grantLiveApproval, withdrawLiveApproval } from "../../app/merchants.js";
import {
  type JournalAction,
  type JournalOutcome,
  type JournalPress,
  JournalReasonSchema,
  type JournalSubject,
} from "../journal.js";
import type { Store } from "../store.js";

/** Why a press was refused, as its row records it; the screen turns each into a sentence. */
export const MERCHANT_ACTION_REFUSALS = [
  /** Admission is a decision of the live channel alone; the test channel asks none. */
  "not_live_channel",
  "no_such_merchant",
  /** No such key among this merchant's: another merchant's key is answered the same way. */
  "no_such_key",
  /** An intervention carries a reason, and this one was blank. */
  "no_reason",
  /** The reason is too long or not plain text, so the journal cannot keep it. */
  "reason_refused",
] as const;

export type MerchantActionRefusal = (typeof MERCHANT_ACTION_REFUSALS)[number];

export type MerchantActionOutcome =
  | Exclude<JournalOutcome, { kind: "refused" }>
  | Readonly<{ kind: "refused"; code: MerchantActionRefusal }>;

/** Who pressed, by their account's identifier, and when. */
export interface OperatorPress {
  readonly operator: string;
  readonly at: number;
}

/**
 * A press that intervenes, with the reason the operator wrote, which the
 * journal keeps. A withdrawal's reason is also the note its merchant reads on
 * their own dashboard while the withdrawal stands, so it names no buyer.
 */
export interface OperatorIntervention extends OperatorPress {
  readonly reason: string;
}

/** An identifier as the product makes them; anything else names no merchant or key. */
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

const pressOf = (
  press: OperatorPress,
  action: JournalAction,
  subject: JournalSubject,
  reason: string | null,
): JournalPress => ({
  at: press.at,
  actor: { kind: "account", id: press.operator },
  action,
  subject,
  reason,
});

async function refused(
  store: Store,
  press: JournalPress,
  code: MerchantActionRefusal,
): Promise<MerchantActionOutcome> {
  await store.recordJournal({ ...press, outcome: { kind: "refused", code } });
  return { kind: "refused", code };
}

const settled = (changed: boolean): MerchantActionOutcome => ({
  kind: changed ? "done" : "unchanged",
});

/**
 * What stands in the way of a press before anything is changed: an identifier
 * no merchant could have, refused with no row since the journal names its
 * subjects by identifier alone; a reason the journal cannot keep, whose row
 * keeps none; or the channel. Null where the press may go ahead.
 */
async function refusedAtTheDoor(
  store: Store,
  press: JournalPress,
  liveOnly?: SurfaceMode,
): Promise<MerchantActionOutcome | null> {
  const { subject, reason } = press;
  const ids = subject.kind === "key" ? [subject.id, subject.merchantId] : [subject.id];
  if (!ids.every((id) => IDENTIFIER.test(id))) {
    return { kind: "refused", code: subject.kind === "key" ? "no_such_key" : "no_such_merchant" };
  }
  if (reason !== null && !JournalReasonSchema.safeParse(reason).success) {
    const code = reason.trim() === "" ? "no_reason" : "reason_refused";
    return await refused(store, { ...press, reason: null }, code);
  }
  if (liveOnly !== undefined && liveOnly !== "live") {
    return await refused(store, press, "not_live_channel");
  }
  return null;
}

/**
 * Admits a merchant to live sales, so their cards sell for real money as soon
 * as nothing else is missing. Asks no reason. Refused off the live channel and
 * for a merchant that is not there. A repeat keeps the first instant.
 */
export async function admitMerchant(
  store: Store,
  surface: SurfaceMode,
  merchantId: string,
  press: OperatorPress,
): Promise<MerchantActionOutcome> {
  const journal = pressOf(press, "admit", { kind: "merchant", id: merchantId }, null);
  const stop = await refusedAtTheDoor(store, journal, surface);
  if (stop !== null) return stop;
  const granted = await grantLiveApproval(store, merchantId, press.at, journal);
  return granted === null
    ? await refused(store, journal, "no_such_merchant")
    : settled(granted.changed);
}

/**
 * Withdraws a merchant's admission, which takes every one of their cards off
 * sale on the live channel at once; it cancels no order already taken and
 * moves no money. The reason is the note the merchant reads while the
 * withdrawal stands. Refused without a reason, off the live channel and for a
 * merchant that is not there.
 */
export async function withdrawAdmission(
  store: Store,
  surface: SurfaceMode,
  merchantId: string,
  press: OperatorIntervention,
): Promise<MerchantActionOutcome> {
  const journal = pressOf(press, "withdraw", { kind: "merchant", id: merchantId }, press.reason);
  const stop = await refusedAtTheDoor(store, journal, surface);
  if (stop !== null) return stop;
  const withdrawn = await withdrawLiveApproval(store, merchantId, journal);
  return withdrawn === null
    ? await refused(store, journal, "no_such_merchant")
    : settled(withdrawn.changed);
}

/**
 * Disables one of a merchant's keys at once; no other key and no session is
 * touched, and the merchant can issue a new one. Refused without a reason and
 * for a key that is not this merchant's, which is answered the same whether
 * it belongs to another merchant or to nobody.
 */
export async function disableMerchantKey(
  store: Store,
  merchantId: string,
  keyId: string,
  press: OperatorIntervention,
): Promise<MerchantActionOutcome> {
  const journal = pressOf(
    press,
    "disable_key",
    { kind: "key", id: keyId, merchantId },
    press.reason,
  );
  const stop = await refusedAtTheDoor(store, journal);
  if (stop !== null) return stop;
  const key = await store.disableKeyOf(merchantId, keyId, press.at, journal);
  // The store stops only a working key, at this press's instant, and leaves a
  // stopped one at its first.
  return key === null
    ? await refused(store, journal, "no_such_key")
    : settled(key.disabledAt === press.at);
}
