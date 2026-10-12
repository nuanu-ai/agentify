/**
 * What the gateway has the dashboard tell a merchant, and what the dashboard
 * answers. The dashboard imports this file through the package's
 * `./announcements` entry, so both sides read one definition.
 *
 * An announcement carries facts, never words or tokens: the dashboard writes
 * the message, and nothing in it can open anything.
 */

/**
 * The hundred characters a key's label is held to at the door, plus one for
 * the ellipsis that says a longer label was cut.
 */
const LONGEST_ANNOUNCED_LABEL = 101;

/**
 * A key's label as an announcement carries it: one line, cut to a hundred
 * characters with an ellipsis saying so. Stored labels are not all held to the
 * door's limit, so every announced label goes through this.
 */
export function announcedLabel(label: string): string {
  const oneLine = label.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
  if (oneLine === "") {
    return "a key whose name has no printable characters";
  }
  const characters = [...oneLine];
  return characters.length <= LONGEST_ANNOUNCED_LABEL - 1
    ? oneLine
    : `${characters
        .slice(0, LONGEST_ANNOUNCED_LABEL - 1)
        .join("")
        .trimEnd()}…`;
}

/**
 * Who asked for a wallet change: the account a dashboard session is signed in
 * as. It names the account, not a person, because a stolen session is signed
 * in as the owner all the same.
 */
export type AskedInTheDashboard = { readonly kind: "signed_in"; readonly email: string };

/**
 * Who asked for a new key: a dashboard session, or a key of the merchant's own
 * code named by its label and identifier as their list of keys shows it, so
 * the reader can find and disable it. The label is always `announcedLabel`'s.
 */
export type AskedWith =
  | AskedInTheDashboard
  | { readonly kind: "merchant_code"; readonly id: string; readonly label: string };

/** An address in the mixed-case checksummed spelling a wallet shows. */
type Wallet = string;

/**
 * A merchant's first payout wallet was set and already applies. Sent after,
 * never waited on; it exists so the owner hears of a wallet somebody else's
 * session set.
 */
interface WalletSet {
  readonly kind: "wallet_set";
  readonly merchant_id: string;
  readonly to: Wallet;
  readonly asked_with: AskedInTheDashboard;
}

/**
 * A replacement for the current wallet was asked for. Sent before anything is
 * written: the change is recorded only if every message was handed over, and
 * takes effect forty-eight hours after that, so no earlier than `not_before`
 * (an ISO 8601 timestamp).
 */
interface WalletChange {
  readonly kind: "wallet_change";
  readonly merchant_id: string;
  readonly from: Wallet;
  readonly to: Wallet;
  readonly not_before: string;
  readonly asked_with: AskedInTheDashboard;
}

/** A pending change was cancelled by asking for the current address. Sent after. */
interface WalletChangeCancelled {
  readonly kind: "wallet_change_cancelled";
  readonly merchant_id: string;
  readonly kept: Wallet;
  readonly cancelled: Wallet;
  readonly asked_with: AskedInTheDashboard;
}

/** A key for the merchant's own code was issued. Sent after, never waited on. */
interface KeyIssued {
  readonly kind: "key_issued";
  readonly merchant_id: string;
  readonly key: { readonly id: string; readonly label: string };
  readonly asked_with: AskedWith;
}

export type Announcement = WalletSet | WalletChange | WalletChangeCancelled | KeyIssued;

/**
 * What became of the messages. `handed_over`: the mail provider took a message
 * for every account naming the merchant. `nobody_to_tell`: no account names
 * the merchant. `not_handed_over`: at least one was not taken, but others may
 * have been, so it must never be read as "nothing was sent".
 */
export interface AnnouncementAnswer {
  readonly outcome: "handed_over" | "nobody_to_tell" | "not_handed_over";
}
