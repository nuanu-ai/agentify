import { z } from "zod";
import { notPlainTextIn } from "./plain-text.js";
import { TimestampSchema } from "./primitives.js";

const MESSAGE_MAX = 2000;

/**
 * The explanation as it is kept and read back: never blank, and at most
 * `MESSAGE_MAX` characters counted as a person counts them, so an emoji is one.
 * That is also how a JSON Schema validator counts `maxLength`, where a
 * JavaScript string's length would count an emoji as two.
 */
const message = z
  .string()
  .regex(/\S/, "a closure message contains words, or is left out")
  .refine(
    (text) => [...text].length <= MESSAGE_MAX,
    `a closure message is at most ${MESSAGE_MAX} characters`,
  )
  .meta({
    maxLength: MESSAGE_MAX,
    description: `The merchant's statement to the buyer, at most ${MESSAGE_MAX} characters, an emoji counting as one.`,
  });

/**
 * Characters that reorder how the text around them is displayed (the
 * embeddings, overrides and isolates), so the words a person sees are not the
 * order they were written in. Left-to-right and right-to-left marks, which
 * only nudge neutral characters, are text.
 */
const BIDIRECTIONAL_CONTROL = /[\u202A-\u202E\u2066-\u2069]/g;

/** Half of a character written as a surrogate pair, with the other half gone. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

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
    if (!text.isWellFormed()) {
      const halves = [...text.matchAll(LONE_SURROGATE)];
      findings.push(
        `${halves.length === 1 ? "half of a character," : `halves of characters in ${halves.length} places, the first`} ${codeOf(halves[0]?.[0] ?? "")} at character ${(halves[0]?.index ?? 0) + 1}, as when text is cut short in the middle of an emoji`,
      );
    }
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
    maxLength: MESSAGE_MAX,
    description: `The merchant's statement to the buyer, at most ${MESSAGE_MAX} characters (an emoji counts as one) of plain text, which the buyer's agent reads exactly as it is written: HTML markup, HTML character references, control characters other than the line feed, bidirectional control characters and half of a character cut in two are refused.`,
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
