/**
 * What the key list and the one page a new key's secret is ever shown on say,
 * as plain values built from the gateway's documents. Each key is a row
 * revocable on its own, without touching any other key or any dashboard
 * session; the dashboard signs in by mailed link and calls the gateway
 * in-process, so no key is the dashboard's own way in and revoking one cannot
 * lock a merchant out. Revoked keys stay on the list, because "which key did I
 * turn off, and when" is asked on exactly this screen. An empty list is the
 * ordinary state of a merchant who has just registered.
 */

import type { MerchantKey } from "@agentify/gateway";
import { type MomentView, momentView } from "./views.js";
import { KEY_WORDS, type Word } from "./words.js";

/**
 * When every deployment had begun recording each key's last call. A key made
 * since that has none recorded was never called; one made before may have
 * been called before recording began, and the row says only that there is no
 * record. Set later than the release that began recording, so an error can
 * only make a key read "Not recorded", never "Never used".
 */
const CALLS_RECORDED_SINCE = Date.parse("2026-09-26T00:00:00Z");

/** What a row says in place of a last call it has none of. */
export type NoCall = "never" | "unrecorded";

interface KeyRow {
  readonly id: string;
  readonly label: string;
  readonly created: MomentView;
  /** Null where the gateway holds no record of a call; `noCall` then says which blank it is. */
  readonly lastCall: MomentView | null;
  readonly noCall: NoCall | null;
  /** Null while the key works. */
  readonly revoked: MomentView | null;
  readonly state: Word;
}

export interface KeysView {
  readonly screen: "list";
  readonly rows: readonly KeyRow[];
  /** Whether a row says "Not recorded", which the line under the list explains. */
  readonly unrecorded: boolean;
  /** The working key whose revoke the address asks to confirm; null otherwise. */
  readonly confirming: string | null;
  /** Why the press that drew this page issued nothing; drawn under the box. */
  readonly problem: string | null;
  /** The name a refused press carried, back in the box to correct. */
  readonly typed: string;
  /**
   * Opened from a link to the new-key form, which then takes the focus and is
   * scrolled to; a #fragment in the address would switch the focus off.
   */
  readonly startNew: boolean;
}

/** The one view that carries a secret: the answer to the press that issued it. */
export interface NewKeyView {
  readonly screen: "issued";
  readonly label: string;
  readonly secret: string;
}

const noCallOf = (entry: MerchantKey): NoCall | null => {
  if (entry.last_used_at !== null) return null;
  return Date.parse(entry.created_at) >= CALLS_RECORDED_SINCE ? "never" : "unrecorded";
};

export const keysView = (
  keys: readonly MerchantKey[],
  {
    problem = null,
    typed = "",
    startNew = false,
    confirming = null,
  }: {
    problem?: string | null;
    typed?: string;
    startNew?: boolean;
    confirming?: string | null;
  } = {},
): KeysView => {
  const rows = keys.map((entry) => ({
    id: entry.id,
    label: entry.label,
    created: momentView(entry.created_at),
    lastCall: entry.last_used_at === null ? null : momentView(entry.last_used_at),
    noCall: noCallOf(entry),
    revoked: entry.disabled_at === null ? null : momentView(entry.disabled_at),
    state: entry.disabled_at === null ? KEY_WORDS.works : KEY_WORDS.revoked,
  }));
  return {
    screen: "list",
    rows,
    unrecorded: rows.some((row) => row.noCall === "unrecorded"),
    // Only a key that still works can be revoked, and only one on the list.
    confirming: rows.some((row) => row.id === confirming && row.revoked === null)
      ? confirming
      : null,
    problem,
    typed,
    startNew,
  };
};

export const newKeyView = (label: string, secret: string): NewKeyView => ({
  screen: "issued",
  label,
  secret,
});
