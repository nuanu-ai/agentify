/**
 * What a merchant's handler answers when an order reaches it: delivered,
 * refused or accepted, and nothing else.
 *
 * A refusal is final and closes the order. A temporary failure is an
 * exception, a dead process or a dropped connection, all of which read as an
 * order not delivered that comes back after a delay. Silence is not an answer:
 * every wait has a deadline, and an order that runs out of time is closed
 * without the handler.
 */

import { z } from "zod";
import { ParamNameSchema } from "./param-spec.js";

/**
 * The three refusal codes Agentify and the merchant read the same way. Prefer
 * them: only `out_of_stock` counts toward the share of purchases that ran into
 * a missing product, and the same refusal under a code of the merchant's own
 * is invisible to that measure.
 */
export const RECOMMENDED_REFUSAL_CODES = Object.freeze({
  OUT_OF_STOCK: "out_of_stock",
  INVALID_PARAMS: "invalid_params",
  CANNOT_FULFILL: "cannot_fulfill",
} as const);

/**
 * A refusal code. The set is open, so a merchant whose reason fits none of the
 * recommended codes sends their own word, but a code is required.
 */
export const RefusalCodeSchema = z
  .string()
  .regex(/\S/, "a refusal carries a short code, even one of the merchant's own")
  .meta({
    // The recommended codes travel in the description, so that a client
    // generated outside TypeScript learns them from the JSON Schema export.
    description:
      'A short code for why a delivery cannot happen. The set is open — a merchant whose reason fits none of ours sends their own word rather than the nearest approximation. Three are understood the same way on both sides and should be preferred: "out_of_stock" (the product is gone: sold out, no seats, the supplier did not deliver), "invalid_params" (the purchase parameters do not work for this delivery), "cannot_fulfill" (it cannot be delivered for some other reason). Only "out_of_stock" feeds the share of purchases that ran into a missing product, which is a number we hold under a limit — the same refusal sent under a merchant\'s own code is invisible to it.',
  });

export const RefusalSchema = z.strictObject({
  code: RefusalCodeSchema,

  /**
   * The reason in words, for the person who picks the case up afterwards; the
   * code is what programs read.
   */
  message: z.string().regex(/\S/, "a refusal carries a reason a person can read"),
});

/**
 * The delivery itself: the JSON the card's `result` declared.
 *
 * Here it is only held to being an object with names a card could have
 * declared; whether it matches a particular card is checked against that
 * card's `result`. It reaches the agent as the merchant wrote it, except a key
 * named `__proto__`, which is dropped (see `PROTOTYPE_KEY_IS_DROPPED`). It is
 * both what a synchronous handler returns and the body of the delivery call.
 */
export const DeliverySchema = z.record(ParamNameSchema, z.unknown()).meta({
  description:
    "What the merchant delivers: the fields the card's result declared. This document holds the names to the shape a card could have declared and no further. That they are the names this particular card declared is checked against that card, and no document standing on its own can express it.",
});

/**
 * Taking an order on: the merchant will deliver it, held to the card's
 * delivery deadline. It carries nothing, and any field sent with it is
 * refused. It is both a handler's answer and the body of a call.
 */
export const AcceptanceSchema = z
  .strictObject(
    {},
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? issue.keys.includes("eta_seconds")
            ? "an acceptance carries nothing: eta_seconds was removed because nothing kept it and no agent saw it, so answer accepted() with nothing in it"
            : `an acceptance carries nothing, and ${issue.keys.join(", ")} is not part of it, so answer accepted() with nothing in it`
          : undefined,
    },
  )
  .meta({
    description:
      "Taking an order on: the merchant will deliver it, and the delivery deadline on the card is what they are held to. It carries nothing; an empty acceptance is the whole answer.",
  });

export const HandlerAnswerSchema = z.union(
  [
    z.strictObject({ delivered: DeliverySchema }),
    z.strictObject({ refused: RefusalSchema }),
    z.strictObject({ accepted: AcceptanceSchema }),
  ],
  {
    error:
      "a handler answers with exactly one of { delivered }, { refused } or { accepted }; a temporary failure is an exception, not a refusal",
  },
);

export type RefusalCode = z.infer<typeof RefusalCodeSchema>;
export type Refusal = z.infer<typeof RefusalSchema>;
export type Delivery = z.infer<typeof DeliverySchema>;
export type Acceptance = z.infer<typeof AcceptanceSchema>;
export type HandlerAnswer = z.infer<typeof HandlerAnswerSchema>;
