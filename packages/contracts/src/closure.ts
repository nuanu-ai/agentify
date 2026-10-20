import { z } from "zod";
import { TimestampSchema } from "./primitives.js";

const message = z
  .string()
  .max(2000, "a closure message is at most 2000 characters")
  .regex(/\S/, "a closure message contains words, or is left out");

/** Stops future Agentify fulfillment; the optional words are the merchant's claim. */
export const OrderCloseRequestSchema = z.strictObject({ message: message.optional() }).meta({
  description:
    "The merchant stops future fulfillment through Agentify. The optional message is preserved as the merchant's statement to the buyer; it establishes no refund or settlement. No financial evidence is accepted.",
});

/** The merchant's recorded action, without a claim about payment being returned. */
export const MerchantClosureSchema = z
  .strictObject({
    closed_at: TimestampSchema,
    message: message.optional(),
  })
  .meta({
    description:
      "Fulfillment closed by the authenticated merchant at closed_at. The optional message is the merchant's statement, not a refund verified or agreement adjudicated by Agentify. Repeating closure preserves the first time and message.",
  });

export type OrderCloseRequest = z.infer<typeof OrderCloseRequestSchema>;
export type MerchantClosure = z.infer<typeof MerchantClosureSchema>;
