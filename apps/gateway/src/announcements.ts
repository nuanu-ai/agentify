/**
 * What the gateway has the dashboard tell a merchant, and what the dashboard
 * answers (ADR-0019).
 *
 * On the live deployment a change of a payout wallet already set is announced
 * to every account that names the merchant before anything is written, and a
 * first wallet, a new key of the merchant's own and a cancelled change are
 * announced once they are done. A wallet is changed only through the dashboard
 * (ADR-0019), so a wallet announcement names no key: it was asked for there.
 * A new key names the key that asked, because any key of the merchant's may
 * issue one.
 *
 * The gateway knows the merchant and the change; the dashboard knows the
 * addresses and sends the mail. The two run in one process (ADR-0030), and the
 * process hands the gateway the dashboard's way of telling, so this is the
 * shape of a call between them rather than a wire: the dashboard imports it
 * from this package's `./announcements` entry, which carries this file and
 * nothing else, so the two sides read one definition.
 *
 * What an announcement carries is facts and no words. The message a person
 * reads is the dashboard's to write, because the dashboard is what knows where
 * its own screens are; the gateway says what changed, from what to what, and,
 * for a new key, which key asked. Nothing in it can open anything: there is no
 * token here, and the message built from it carries none.
 */

/**
 * The longest a key's label is when an announcement names the key: the
 * hundred characters a new key's label is held to at the door, and the one
 * character that says a longer label was cut.
 */
const LONGEST_ANNOUNCED_LABEL = 101;

/**
 * A key's label as an announcement carries it: one line, cut to a hundred
 * characters with an ellipsis saying so.
 *
 * A new key's label is held to that at the door, but a key written before the
 * door held labels to anything, including one a terminal command issued when
 * there was such a command, can be named anything at all — and an announcement
 * of a key issued with such a key must still read as one line in a message. So
 * the gateway writes every label it announces down to this.
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
 * Which key a new key was issued with, named the way the merchant's list of
 * keys names it.
 *
 * A key of the merchant's own code is on that list under its label, with its
 * identifier beneath, so that is how a message names it: a person reading "the
 * key you called the stock worker" can find the row and disable it. The key the
 * dashboard signs in with is on no list, and a call made with it means a person
 * signed in to the dashboard acted — so it is named as the dashboard and nothing
 * more. A label here is always one written by `announcedLabel`.
 */
export type AskedWith =
  | { readonly kind: "dashboard" }
  | { readonly kind: "merchant_code"; readonly id: string; readonly label: string };

/**
 * An address as the gateway holds one, the mixed-case spelling a wallet shows,
 * and an instant as an ISO 8601 timestamp with its offset.
 */
type Wallet = string;

/**
 * A merchant's first payout wallet was set in the dashboard, and applies
 * already. Sent after, and never waited on: it replaces nothing, and a new
 * merchant has to be able to start selling — but a session that is not the
 * owner's could set it, and this is how the owner hears of it.
 */
interface WalletSet {
  readonly kind: "wallet_set";
  readonly merchant_id: string;
  readonly to: Wallet;
}

/**
 * A replacement for the wallet paid now has been asked for. Sent before
 * anything is written; the change is recorded only if every message was
 * handed over, and it takes effect forty-eight hours after that — which is
 * after `not_before`, the instant the gateway can name while it is still
 * asking.
 */
interface WalletChange {
  readonly kind: "wallet_change";
  readonly merchant_id: string;
  readonly from: Wallet;
  readonly to: Wallet;
  readonly not_before: string;
}

/** A waiting change was cancelled by asking for the address paid now. Sent after. */
interface WalletChangeCancelled {
  readonly kind: "wallet_change_cancelled";
  readonly merchant_id: string;
  readonly kept: Wallet;
  readonly cancelled: Wallet;
}

/** A key for the merchant's own code was issued. Sent after, and never waited on. */
interface KeyIssued {
  readonly kind: "key_issued";
  readonly merchant_id: string;
  readonly key: { readonly id: string; readonly label: string };
  readonly asked_with: AskedWith;
}

/** What the gateway has the dashboard tell a merchant. */
export type Announcement = WalletSet | WalletChange | WalletChangeCancelled | KeyIssued;

/**
 * What became of the messages, as the dashboard knows it.
 *
 * `handed_over` is every account naming the merchant sent a message the mail
 * provider took. `nobody_to_tell` is no account names the merchant, so nothing
 * was sent. `not_handed_over` is at least one message the provider would not
 * take — and others may have been, which is why nothing a caller says about
 * this may read as "nothing was sent".
 */
export interface AnnouncementAnswer {
  readonly outcome: "handed_over" | "nobody_to_tell" | "not_handed_over";
}
