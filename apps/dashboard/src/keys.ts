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

interface KeyRow {
  readonly id: string;
  readonly label: string;
  readonly created: MomentView;
  /**
   * Null where the gateway holds no record of a call. A key made before it
   * started recording has the same blank as a key never used, and the wire
   * does not say which, so the screen claims only a missing record.
   */
  readonly lastCall: MomentView | null;
  /** Null while the key works. */
  readonly revoked: MomentView | null;
  readonly state: Word;
}

export interface KeysView {
  readonly screen: "list";
  readonly lede: string;
  readonly rows: readonly KeyRow[];
  /** Why the press that drew this page issued nothing; drawn under the form. */
  readonly problem: string | null;
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

/**
 * Said whether or not there are rows, so an empty list is answered by what the
 * list is rather than by what is missing.
 */
const WHAT_A_KEY_IS = "Your code uses these keys to connect to Agentify.";

export const keysView = (
  keys: readonly MerchantKey[],
  { problem = null, startNew = false }: { problem?: string | null; startNew?: boolean } = {},
): KeysView => {
  const working = keys.filter((entry) => entry.disabled_at === null).length;
  return {
    screen: "list",
    lede:
      keys.length === 0
        ? `You haven't created any API keys yet. ${WHAT_A_KEY_IS}`
        : `${working} of the ${keys.length} ${keys.length === 1 ? "key" : "keys"} below` +
          `${working === 1 ? " works" : " work"}. ${WHAT_A_KEY_IS}`,
    rows: keys.map((entry) => ({
      id: entry.id,
      label: entry.label,
      created: momentView(entry.created_at),
      lastCall: entry.last_used_at === null ? null : momentView(entry.last_used_at),
      revoked: entry.disabled_at === null ? null : momentView(entry.disabled_at),
      state: entry.disabled_at === null ? KEY_WORDS.works : KEY_WORDS.revoked,
    })),
    problem,
    startNew,
  };
};

export const newKeyView = (label: string, secret: string): NewKeyView => ({
  screen: "issued",
  label,
  secret,
});
