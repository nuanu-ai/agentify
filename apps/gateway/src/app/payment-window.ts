/**
 * How long an agent's payment authorisation has to stay valid, worked out from
 * the deadlines and the waits on a payment's path in one place: for the
 * challenge that asks for it, and for the check that holds a presented
 * payment to it.
 */

import type { GatewayConfig } from "../config.js";

type Deadlines = Pick<GatewayConfig["deadlines"], "quoteTtlMs" | "syncResponseMs">;

/**
 * How long a wallet's balance read may take. It runs before a payment is
 * checked, and again while a payment's refusal is on its way to the buyer,
 * so it gives up early and the payment, or its refusal, goes on as it was.
 */
export const BALANCE_READ_MS = 2_000;

/** How long a payment waits for a place among its merchant's checks before it is sent back. */
export const PAYMENT_PLACE_WAIT_MS = 2_000;

/**
 * How long a payment check may take. It holds one of its merchant's places
 * for payment checks while it waits, so it gives up well before a charge does.
 */
export const VERIFY_REQUEST_MS = 10_000;

/**
 * How long a charge may take: the library's own thirty seconds, which the
 * charge deadlines in research 46 are set against, written down here.
 */
export const SETTLE_REQUEST_MS = 30_000;

/**
 * How close to its end the exact-EVM facilitator lets an authorisation come: it
 * refuses one that ends within this long, at the check and again at the
 * charge. Read in `@x402/evm`; whether the hosted facilitators the channels
 * settle through keep the same margin has not been checked.
 */
const FACILITATOR_EXPIRY_MARGIN_MS = 6_000;

/**
 * What the arithmetic cannot count exactly, allowed once on each side of the
 * check: after it, the gateway's own steps before the charge goes out and the
 * difference between its clock and the facilitator's; before it, the check's
 * round trip and the reference client rounding its clock down to the second.
 * Chosen, not measured.
 */
const UNCOUNTED_MS = 2_000;

/**
 * How long an authorisation has to stay valid once its payment has checked
 * out, where the goods are still to be made and are charged for after: the
 * time the merchant has to answer with them, the facilitator's margin when the
 * charge goes out, and the allowance.
 */
export const validityNeededAfterCheckMs = (deadlines: Pick<Deadlines, "syncResponseMs">): number =>
  deadlines.syncResponseMs + FACILITATOR_EXPIRY_MARGIN_MS + UNCOUNTED_MS;

/**
 * How long a challenge asks an agent's authorisation to stay valid, in the
 * protocol's whole seconds. The price's whole life is there for an agent that
 * signs as soon as the price is named and presents the payment as it runs out;
 * after that comes what the check asks for, and the allowance for the time
 * before the check. Rounded up, since longer is safe and shorter is not. It is
 * not the time an agent has to pay: the price lapses long before.
 */
export const authorisationSecondsOf = (deadlines: Deadlines): number =>
  Math.ceil((deadlines.quoteTtlMs + validityNeededAfterCheckMs(deadlines) + UNCOUNTED_MS) / 1_000);
