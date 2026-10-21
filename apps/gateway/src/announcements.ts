/**
 * What the gateway has the dashboard tell a merchant, and what the dashboard
 * answers. The dashboard imports this file through the package's
 * `./announcements` entry, so both sides read one definition.
 *
 * An announcement carries facts, never words or tokens: the dashboard writes
 * the message, and nothing in it can open anything.
 */

/**
 * Who asked for a wallet change or a new key: the account a dashboard session
 * is signed in as. It names the account, not a person, because a stolen
 * session is signed in as the owner all the same.
 */
export type AskedInTheDashboard = { readonly kind: "signed_in"; readonly email: string };

/** An address in the mixed-case checksummed spelling a wallet shows. */
type Wallet = string;

/**
 * The payout split a wallet is paid through: the address buyers pay into,
 * which pays the wallet the merchant's share and Agentify its commission, in
 * the checksummed spelling, as the registry records it.
 */
type Split = string;

/**
 * A merchant's first payout wallet was set and already applies. Sent after,
 * never waited on; it exists so the owner hears of a wallet somebody else's
 * session set.
 */
interface WalletSet {
  readonly kind: "wallet_set";
  readonly merchant_id: string;
  readonly to: Wallet;
  readonly to_split: Split;
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
  /** The split buyers pay into until the change applies. */
  readonly from_split: Split;
  readonly to: Wallet;
  /** The split buyers pay into once it applies, recorded with the change. */
  readonly to_split: Split;
  readonly not_before: string;
  readonly asked_with: AskedInTheDashboard;
}

/** A pending change was cancelled by asking for the current address. Sent after. */
interface WalletChangeCancelled {
  readonly kind: "wallet_change_cancelled";
  readonly merchant_id: string;
  readonly kept: Wallet;
  readonly kept_split: Split;
  readonly cancelled: Wallet;
  readonly asked_with: AskedInTheDashboard;
}

/** A key for the merchant's own code was issued. Sent after, never waited on. */
interface KeyIssued {
  readonly kind: "key_issued";
  readonly merchant_id: string;
  readonly key: { readonly id: string; readonly label: string };
  readonly asked_with: AskedInTheDashboard;
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
