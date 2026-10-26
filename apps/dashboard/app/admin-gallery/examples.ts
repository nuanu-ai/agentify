/**
 * The example channel every area's gallery states describe: one moment they
 * are read at, the merchants they name and the thirty days of sales they
 * count, so a figure on one page agrees with the same figure on another. Made
 * up, as a shop on the channel would look: no real merchant's.
 */

import type { SalesByDay } from "../../src/admin/figures.js";

/** The moment every state is read at: 23 October 2026, 14:05 UTC. */
export const AT = Date.parse("2026-10-23T14:05:00.000Z");

export const DAY = 86_400_000;

/** The merchant that sells: admitted, with two wallets over its life. */
export const TOURS = {
  id: "mch_91b0e7d4c25a8f6013e9b2d7c4a50f18",
  name: "City Walking Tours",
  site: "https://tours.example",
  owner: "owner@tours.example",
  wallet: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  split: "0x2b7c1b5f3d6c4e8a9b0c1d2e3f405162738495e1",
  earlierWallet: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  earlierSplit: "0x7a3f9e8d7c6b5a4938271605f4e3d2c1b0a988f3",
  admittedAt: Date.UTC(2026, 8, 14, 10, 2),
} as const;

/** The merchant that waits for admission, its wallet about to change. */
export const GIFT_CARDS = {
  id: "mch_4c1da2e95b7f0c3816de42a90e5b71c3",
  name: "Gift Card Shop",
  site: "https://giftcards.example",
  owner: "owner@giftcards.example",
  wallet: "0xC41e079Ab233f8D51c0e9A6b47F2d388c1a05E7d",
  split: "0x91fa3c27E0b84d65aF19c03e7B2d58c4A6e10c3d",
  createdAt: Date.UTC(2026, 9, 19),
  walletLandsAt: Date.UTC(2026, 9, 25, 9, 0),
} as const;

/** How many merchants the channel holds, of which the tours alone sells. */
export const MERCHANTS_IN_ALL = 23;

/**
 * Thirty days of the tours' sales, which are the channel's, the oldest first:
 * a few quiet days, and two days with a payment whose delivery is not recorded.
 */
export const SALES: SalesByDay = {
  readAt: AT,
  undated: { amount: "0.00", count: 0 },
  days: Array.from({ length: 30 }, (_, index) => {
    const day = new Date(AT - (29 - index) * DAY).toISOString().slice(0, 10);
    const quiet = index % 6 === 1;
    const dollars = quiet ? 0 : 5 + ((index * 7) % 23);
    const nodel = index === 27 ? "12.00" : index === 28 ? "8.00" : "0.00";
    return {
      day,
      delivered: { amount: `${dollars}.00`, count: quiet ? 0 : 1 + (index % 3) },
      noDelivery: { amount: nodel, count: nodel === "0.00" ? 0 : 1 },
    };
  }),
};
