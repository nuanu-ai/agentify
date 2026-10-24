/**
 * Money as the operator's figures add it up: exact, in millionths of a dollar,
 * never through a float. A price is charged in USDC one for one with the US
 * dollar and carries at most six places, so a millionth is the finest amount
 * any sale holds, and every sum here is exact. Both readers turn what they
 * summed into the same words through `dollarsOf`, so the same rows give the
 * same string in memory and in Postgres.
 */

import { PAYABLE_CURRENCIES, PAYABLE_DECIMALS } from "@nuanu-ai/agentify-contracts";

/** An amount in US dollars, written with at least two places and at most six: "437.00", "0.1185". */
export type Dollars = string;

/** A count of payments and the dollars they carried. */
export interface Tally {
  readonly amount: Dollars;
  readonly count: number;
}

const SCALE = 10n ** BigInt(PAYABLE_DECIMALS);
const DECIMAL = new RegExp(`^(\\d+)(?:\\.(\\d{1,${PAYABLE_DECIMALS}}))?$`);

/**
 * The millionths of a dollar an amount holds. Refuses an amount in any other
 * currency than the dollars a sale is charged in, and one this cannot hold
 * exactly: a figure added from a guess would be the one wrong number on the
 * page, so the read fails instead and the page says it could not be read.
 */
export function microsOf(amount: string, currency = "USD"): bigint {
  if (!PAYABLE_CURRENCIES.includes(currency)) {
    throw new Error(
      `an order is priced in ${JSON.stringify(currency)}, which is not US dollars, and nothing here converts it`,
    );
  }
  const written = DECIMAL.exec(amount.trim());
  if (written === null) {
    throw new Error(`an order carries the amount ${JSON.stringify(amount)}, which is not dollars`);
  }
  const [, whole = "0", places = ""] = written;
  return BigInt(whole) * SCALE + BigInt(places.padEnd(PAYABLE_DECIMALS, "0"));
}

/** Millionths of a dollar written as dollars: two places at least, six at most, no trailing zeros past the cents. */
export function dollarsOf(micros: bigint): Dollars {
  const whole = micros / SCALE;
  const places = (micros % SCALE).toString().padStart(PAYABLE_DECIMALS, "0").replace(/0+$/, "");
  return `${whole}.${places.padEnd(2, "0")}`;
}

/**
 * The commission a split accrues on what settled into it: its commission
 * allocation's part of the whole, rounded down to the millionth as the split
 * itself rounds a distribution. Accrued, not received: the money stays in the
 * split until somebody pays it out.
 */
export function commissionOn(
  micros: bigint,
  split: { readonly commissionAllocation: number; readonly totalAllocation: number },
): bigint {
  return (micros * BigInt(split.commissionAllocation)) / BigInt(split.totalAllocation);
}

/** Why a read stops at an order that was paid and carries no price: a defect, never a sale of nothing. */
export const paidWithNoPrice = (orderId: string): Error =>
  new Error(`the order ${orderId} was paid and carries no price`);

/** A tally of `count` payments carrying `micros` in all. */
export const tallyOf = (micros: bigint, count: number): Tally => ({
  amount: dollarsOf(micros),
  count,
});
