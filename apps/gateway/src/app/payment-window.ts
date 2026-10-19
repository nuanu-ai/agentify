/**
 * How long an agent's payment authorisation has to stay valid, worked out from
 * the deadlines in one place: for the challenge that asks for it, and for the
 * check that holds a presented payment to it.
 */

import type { GatewayConfig } from "../config.js";

type Deadlines = Pick<GatewayConfig["deadlines"], "quoteTtlMs" | "syncResponseMs">;

/**
 * How close to its end the exact-EVM facilitator lets an authorisation come: it
 * refuses one that ends within this long, at the check and again at the
 * charge. Read in `@x402/evm`; whether the live chain's facilitator keeps the
 * same margin is not known.
 */
const FACILITATOR_EXPIRY_MARGIN_MS = 6_000;

/**
 * How long an authorisation has to stay valid once its payment has checked
 * out, on a card charged after its goods: the time the merchant has to answer
 * with them, and then the facilitator's margin when the charge goes out.
 */
export const validityNeededAfterCheckMs = (deadlines: Pick<Deadlines, "syncResponseMs">): number =>
  deadlines.syncResponseMs + FACILITATOR_EXPIRY_MARGIN_MS;

/**
 * How long a challenge asks an agent's authorisation to stay valid, in the
 * protocol's whole seconds: the price's whole life, so that one signed as the
 * price runs out still checks out, and then what a charge after the goods
 * needs. Rounded up, since longer is safe and shorter is not. It is not the
 * time an agent has to pay: the price lapses long before.
 */
export const authorisationSecondsOf = (deadlines: Deadlines): number =>
  Math.ceil((deadlines.quoteTtlMs + validityNeededAfterCheckMs(deadlines)) / 1_000);
