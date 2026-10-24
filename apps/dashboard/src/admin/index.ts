/**
 * The operator's workspace's server halves, as `PageServices.admin`. Each
 * area's module answers its own pages and presses; this file only puts them
 * together, one line an area, with what every page shares: the operator
 * check, the frame and the press that asks for a fresh sign-in.
 */

import { type Operator, operatorOf } from "./access.js";
import { type AccountsPages, accountsFor } from "./accounts.js";
import { type FiguresPages, figuresFor } from "./figures.js";
import { type AdminFrameView, frameView } from "./frame.js";
import { type MerchantsPages, merchantsFor } from "./merchants.js";
import { type OrdersPages, ordersFor } from "./orders.js";
import type { AdminParts } from "./parts.js";
import { type SignInAgainPages, signInAgainFor } from "./step-up.js";

export interface AdminServices {
  /** The operator a request's session is, or null for anybody the flag does not confirm. */
  operatorOf(cookie: string | undefined): Promise<Operator | null>;
  frame(operator: Operator): Promise<AdminFrameView>;
  readonly signInAgain: SignInAgainPages;
  readonly merchants: MerchantsPages;
  readonly orders: OrdersPages;
  readonly figures: FiguresPages;
  readonly accounts: AccountsPages;
}

export function adminServicesFor(parts: AdminParts): AdminServices {
  const merchants = merchantsFor(parts);
  const orders = ordersFor(parts);
  const figures = figuresFor(parts);
  const accounts = accountsFor(parts);
  return {
    operatorOf: (cookie) => operatorOf(parts.identity, cookie),
    frame: (operator) =>
      frameView(parts.config, operator, [
        merchants.counts,
        orders.counts,
        figures.counts,
        accounts.counts,
      ]),
    signInAgain: signInAgainFor(parts.identity, parts.now),
    merchants,
    orders,
    figures,
    accounts,
  };
}
