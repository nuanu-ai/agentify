/**
 * What the gateway asks the cabinet over the one internal route between them,
 * and what the cabinet answers (ADR-0005 §3, ADR-0019).
 *
 * The route and its secret are named for the gateway, not for what it asks,
 * and each request says what it asks in `operation`, the way the scanner's
 * route says it (ADR-0026 §2). Today the gateway asks one thing, to announce:
 * on the live deployment a change of a payout wallet already set is announced
 * to every account that names the merchant before anything is written, and a
 * first wallet, a new key of the merchant's own and a cancelled change are
 * announced once they are done. A wallet is changed only with the cabinet's
 * own key (ADR-0019), so a wallet announcement names no key: it was asked for
 * through the cabinet. A new key names the key that asked,
 * because any key of the merchant's may issue one. Anything else the gateway
 * ever needs from the cabinet is another `operation` in
 * `GatewayRequestSchema`, over this route and with this secret, never a
 * second route or a second secret.
 *
 * The gateway knows the merchant and the change; the cabinet knows
 * the addresses and sends the mail. This file is the wire between them, and it
 * is here rather than in the published contracts because nobody outside these
 * two processes calls it: the cabinet imports it from this package's
 * `./announcements` entry, which carries this file and nothing else, so the
 * two sides read one definition.
 *
 * What a request carries is facts and no words. The message a person reads is
 * the cabinet's to write, because the cabinet is what knows where its own
 * screens are; the gateway says what changed, from what to what, and, for a
 * new key, which key asked. Nothing in it can open anything: there is no
 * token here, and the message built from it carries none.
 */

import { checksummedAddressOf, EvmAddressSchema } from "@nuanu-ai/agentify-contracts";
import { z } from "zod";

/** The path the cabinet answers the gateway on, on its own listener inside the compose network. */
export const GATEWAY_ROUTE_PATH = "/internal/gateway";

/** The port of that listener. Nothing publishes it. */
export const GATEWAY_ROUTE_PORT = 3003;

/** An address as the gateway holds one: the mixed-case spelling a wallet shows. */
const WalletSchema = EvmAddressSchema.refine(
  (address) => address === checksummedAddressOf(address),
  "an address in an announcement is written the way a wallet shows it",
);

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
 * of a key issued with such a key must still be one the cabinet takes. So the
 * gateway writes every label it
 * announces down to this, and the cabinet refuses anything else.
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

/** A label on the wire: one line, not empty, no longer than a cut label. */
const AnnouncedLabelSchema = z
  .string()
  .min(1)
  .max(LONGEST_ANNOUNCED_LABEL * 2)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u, "a label is announced as one line")
  .refine(
    (label) => [...label].length <= LONGEST_ANNOUNCED_LABEL,
    "a label is announced cut to one line",
  );

/**
 * Which key a new key was issued with, named the way the merchant's list of
 * keys names it.
 *
 * A key of the merchant's own code is on that list under its label, with its
 * identifier beneath, so that is how a message names it: a person reading "the
 * key you called the stock worker" can find the row and disable it. The key the
 * cabinet signs in with is on no list, and a call made with it means a person
 * signed in to the cabinet acted — so it is named as the cabinet and nothing
 * more.
 */
export const AskedWithSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cabinet") }),
  z.strictObject({
    kind: z.literal("merchant_code"),
    id: z.string().min(1),
    label: AnnouncedLabelSchema,
  }),
]);

/**
 * A merchant's first payout wallet was set in the cabinet, and applies
 * already. Sent after, and never waited on: it replaces nothing, and a new
 * merchant has to be able to start selling — but a session that is not the
 * owner's could set it, and this is how the owner hears of it.
 */
const WalletSetSchema = z.strictObject({
  kind: z.literal("wallet_set"),
  merchant_id: z.string().min(1),
  to: WalletSchema,
});

/**
 * A replacement for the wallet paid now has been asked for. Sent before
 * anything is written; the change is recorded only if every message was
 * handed over, and it takes effect forty-eight hours after that — which is
 * after `not_before`, the instant the gateway can name while it is still
 * asking.
 */
const WalletChangeSchema = z.strictObject({
  kind: z.literal("wallet_change"),
  merchant_id: z.string().min(1),
  from: WalletSchema,
  to: WalletSchema,
  not_before: z.iso.datetime({ offset: true }),
});

/** A waiting change was cancelled by asking for the address paid now. Sent after. */
const WalletChangeCancelledSchema = z.strictObject({
  kind: z.literal("wallet_change_cancelled"),
  merchant_id: z.string().min(1),
  kept: WalletSchema,
  cancelled: WalletSchema,
});

/** A key for the merchant's own code was issued. Sent after, and never waited on. */
const KeyIssuedSchema = z.strictObject({
  kind: z.literal("key_issued"),
  merchant_id: z.string().min(1),
  key: z.strictObject({ id: z.string().min(1), label: AnnouncedLabelSchema }),
  asked_with: AskedWithSchema,
});

/** What the gateway has the cabinet tell a merchant. */
const AnnouncementSchema = z.discriminatedUnion("kind", [
  WalletSetSchema,
  WalletChangeSchema,
  WalletChangeCancelledSchema,
  KeyIssuedSchema,
]);

const ANNOUNCE = { operation: z.literal("announce") };

/**
 * Everything the gateway may ask the cabinet over its route, told apart by
 * `operation`. A request to announce is an announcement with
 * `"operation": "announce"` beside its `kind`.
 */
export const GatewayRequestSchema = z.discriminatedUnion("operation", [
  z.discriminatedUnion("kind", [
    WalletSetSchema.extend(ANNOUNCE),
    WalletChangeSchema.extend(ANNOUNCE),
    WalletChangeCancelledSchema.extend(ANNOUNCE),
    KeyIssuedSchema.extend(ANNOUNCE),
  ]),
]);

/**
 * What became of the messages, as the cabinet knows it.
 *
 * `handed_over` is every account naming the merchant sent a message the mail
 * provider took. `nobody_to_tell` is no account names the merchant, so nothing
 * was sent. `not_handed_over` is at least one message the provider would not
 * take — and others may have been, which is why nothing a caller says about
 * this may read as "nothing was sent".
 */
export const AnnouncementAnswerSchema = z.strictObject({
  outcome: z.enum(["handed_over", "nobody_to_tell", "not_handed_over"]),
});

export type AskedWith = z.infer<typeof AskedWithSchema>;
export type Announcement = z.infer<typeof AnnouncementSchema>;
export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;
export type AnnouncementAnswer = z.infer<typeof AnnouncementAnswerSchema>;
