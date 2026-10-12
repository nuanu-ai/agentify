/**
 * One message on the merchant's worker stream: the format between the gateway
 * and the SDK. A merchant's handler is given the order, never the envelope.
 *
 * One subscription carries orders, price questions and order events, so each
 * is wrapped in the same envelope, whose `kind` says which it holds and is
 * checked against the payload. The payload sits under its own key so that the
 * envelope's `id` and an order's `id` can never be the same field. The kinds
 * are the names the contract registry publishes for those documents.
 *
 * An order is delivered at least once and an event at most once: an order
 * comes again when the gateway decides on another attempt, and an event never
 * does. A consumer that guards one the way it guards the other has the wrong
 * guard on both.
 */

import { z } from "zod";
import { OrderEventSchema } from "./events.js";
import { OrderSchema } from "./order.js";
import { IdentifierSchema, TimestampSchema } from "./primitives.js";
import { QuoteRequestSchema } from "./quote.js";

/** What each kind of envelope holds; the union below is built from these. */
export const WORKER_ENVELOPE_PAYLOADS = Object.freeze({
  /** A purchase that is paid for as far as its mode requires, waiting to be delivered. */
  order: OrderSchema,
  /** "How much is this and is it there", asked before a sale goes through. */
  quote_request: QuoteRequestSchema,
  /** Something that happened to an order without the merchant doing anything. */
  order_event: OrderEventSchema,
} as const);

/** The marker one envelope carries, naming what its payload is. */
export type WorkerEnvelopeKind = keyof typeof WORKER_ENVELOPE_PAYLOADS;

export const WORKER_ENVELOPE_KINDS = Object.freeze(
  Object.keys(WORKER_ENVELOPE_PAYLOADS),
) as readonly WorkerEnvelopeKind[];

/**
 * The fields every envelope carries.
 *
 * `id` names this message, not the work in it, and is no way to recognise a
 * repeat: an order sent again comes in a fresh envelope with a fresh `id`.
 * What holds still across a repeat is the order's own `id` inside the payload,
 * and that is what a handler answers from.
 */
const envelopeOf = <Kind extends WorkerEnvelopeKind, Payload extends z.ZodType>(
  kind: Kind,
  payload: Payload,
) =>
  z.strictObject({
    kind: z.literal(kind),
    id: IdentifierSchema,
    sent_at: TimestampSchema,
    payload,
  });

export const WorkerEnvelopeSchema = z.discriminatedUnion("kind", [
  envelopeOf("order", WORKER_ENVELOPE_PAYLOADS.order),
  envelopeOf("quote_request", WORKER_ENVELOPE_PAYLOADS.quote_request),
  envelopeOf("order_event", WORKER_ENVELOPE_PAYLOADS.order_event),
]);

export type WorkerEnvelope = z.infer<typeof WorkerEnvelopeSchema>;
