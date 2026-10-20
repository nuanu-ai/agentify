import { z } from "zod";
import { notPlainTextIn } from "./plain-text.js";
import { TimestampSchema } from "./primitives.js";

const MESSAGE_MAX = 2000;

/** The explanation as it is kept and read back: bounded, and never blank. */
const message = z
  .string()
  .max(MESSAGE_MAX, `a closure message is at most ${MESSAGE_MAX} characters`)
  .regex(/\S/, "a closure message contains words, or is left out");

/**
 * Characters that reorder how the text around them is displayed (the
 * embeddings, overrides and isolates), so the words a person sees are not the
 * order they were written in. Left-to-right and right-to-left marks, which
 * only nudge neutral characters, are text.
 */
const BIDIRECTIONAL_CONTROL = /[‪-‮⁦-⁩]/g;

const codeOf = (character: string): string =>
  `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * The explanation as a merchant sends it: plain text on as many lines as it
 * needs, the rule a card's description is held to, with no bidirectional
 * control either. It is held on the way in only, as a card's words are, so a
 * stored closure is always read back.
 */
const sentMessage = message
  .superRefine((text, ctx) => {
    const findings = [...notPlainTextIn(text, "several lines")];
    const reordering = [...text.matchAll(BIDIRECTIONAL_CONTROL)];
    const first = reordering[0];
    if (first !== undefined) {
      findings.push(
        `${reordering.length === 1 ? "a bidirectional control character," : `bidirectional control characters in ${reordering.length} places, the first`} ${codeOf(first[0])} at character ${first.index + 1}`,
      );
    }
    for (const phrase of findings) {
      ctx.addIssue({
        code: "custom",
        message: `a closure message carries ${phrase}, and it is plain text, which the buyer's agent reads exactly as it is written`,
      });
    }
  })
  .meta({
    description: `The merchant's statement to the buyer, at most ${MESSAGE_MAX} characters of plain text, which the buyer's agent reads exactly as it is written: HTML markup, HTML character references, control characters other than the line feed, and bidirectional control characters are refused.`,
  });

/** Stops future Agentify fulfillment; the optional words are the merchant's claim. */
export const OrderCloseRequestSchema = z
  .strictObject({
    message: sentMessage.optional(),
  })
  .meta({
    description:
      "The merchant stops future fulfillment through Agentify. The optional message is kept as the merchant's statement to the buyer, attributed to the merchant; it establishes no refund or settlement. No financial evidence is accepted.",
  });

/** The merchant's recorded action, without a claim about payment being returned. */
export const MerchantClosureSchema = z
  .strictObject({
    closed_at: TimestampSchema,
    message: message.optional(),
  })
  .meta({
    description:
      "Fulfillment closed by the authenticated merchant at closed_at. The optional message is the merchant's statement, not a refund verified or agreement adjudicated by Agentify. Repeating the closure keeps this time and message, except after a payment that completed once the order was closed: the merchant's next closure is then recorded in their place.",
  });

export type OrderCloseRequest = z.infer<typeof OrderCloseRequestSchema>;
export type MerchantClosure = z.infer<typeof MerchantClosureSchema>;
