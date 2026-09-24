/**
 * What the gateway asks the cabinet to tell a merchant, and what the cabinet
 * answers — the one call that goes from the money path to the cabinet
 * (ADR-0005 §3, ADR-0019).
 *
 * On the live deployment a change of a payout wallet already set is announced
 * to every account that names the merchant before anything is written, and a
 * new key of the merchant's own and a cancelled change are announced once they
 * are done. The gateway knows the merchant and the change; the cabinet knows
 * the addresses and sends the mail. This file is the wire between them, and it
 * is here rather than in the published contracts because nobody outside these
 * two processes calls it: the cabinet imports it from this package's
 * `./announcements` entry, which carries this file and nothing else, so the
 * two sides read one definition.
 *
 * What a request carries is facts and no words. The message a person reads is
 * the cabinet's to write, because the cabinet is what knows where its own
 * screens are; the gateway says what changed, from what to what, and which key
 * asked. Nothing in it can open anything: there is no token here, and the
 * message built from it carries none.
 */

import { checksummedAddressOf, EvmAddressSchema } from "@nuanu-ai/agentify-contracts";
import { z } from "zod";

/** The path the cabinet answers on, on its own listener inside the compose network. */
export const ANNOUNCEMENTS_PATH = "/internal/announcements";

/** The port of that listener. Nothing publishes it. */
export const ANNOUNCEMENTS_PORT = 3003;

/** An address as the gateway holds one: the mixed-case spelling a wallet shows. */
const WalletSchema = EvmAddressSchema.refine(
  (address) => address === checksummedAddressOf(address),
  "an address in an announcement is written the way a wallet shows it",
);

/**
 * Which key a call was made with, named the way the merchant's list of keys
 * names it.
 *
 * A key of the merchant's own code is on that list under its label, with its
 * identifier beneath, so that is how a message names it: a person reading "the
 * key you called the stock worker" can find the row and disable it. The key the
 * cabinet signs in with is on no list, and a call made with it means a person
 * signed in to the cabinet acted — so it is named as the cabinet and nothing
 * more (ADR-0019).
 */
export const AskedWithSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cabinet") }),
  z.strictObject({
    kind: z.literal("merchant_code"),
    id: z.string().min(1),
    label: z.string().min(1),
  }),
]);

export const AnnouncementSchema = z.discriminatedUnion("kind", [
  /**
   * A replacement for the wallet paid now has been asked for. Sent before
   * anything is written; the change is recorded only if every message was
   * handed over, and it takes effect forty-eight hours after that — which is
   * after `not_before`, the instant the gateway can name while it is still
   * asking.
   */
  z.strictObject({
    kind: z.literal("wallet_change"),
    merchant_id: z.string().min(1),
    from: WalletSchema,
    to: WalletSchema,
    not_before: z.iso.datetime({ offset: true }),
    asked_with: AskedWithSchema,
  }),
  /** A waiting change was cancelled by asking for the address paid now. Sent after. */
  z.strictObject({
    kind: z.literal("wallet_change_cancelled"),
    merchant_id: z.string().min(1),
    kept: WalletSchema,
    cancelled: WalletSchema,
    asked_with: AskedWithSchema,
  }),
  /** A key for the merchant's own code was issued. Sent after, and never waited on. */
  z.strictObject({
    kind: z.literal("key_issued"),
    merchant_id: z.string().min(1),
    key: z.strictObject({ id: z.string().min(1), label: z.string().min(1) }),
    asked_with: AskedWithSchema,
  }),
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
export type AnnouncementAnswer = z.infer<typeof AnnouncementAnswerSchema>;
