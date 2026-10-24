/**
 * The operator's workspace's server halves. Each area's module answers its own
 * pages and presses; this file only puts them together, one line an area, with
 * what every page shares: the frame and the press that asks for a fresh
 * sign-in.
 *
 * The services are reached only through the door, which reads the operator
 * flag on the request's own session: `PageServices.workspace` holds the door,
 * not the services, so a route outside the workspace's layout cannot reach
 * the operator's reader, and a forged `Operator` opens nothing.
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
  frame(operator: Operator): Promise<AdminFrameView>;
  readonly signInAgain: SignInAgainPages;
  readonly merchants: MerchantsPages;
  readonly orders: OrdersPages;
  readonly figures: FiguresPages;
  readonly accounts: AccountsPages;
}

/** What the workspace's layout hands its pages once the flag confirmed the request. */
export type Workspace = Readonly<{ admin: AdminServices; operator: Operator }>;

export interface WorkspaceDoor {
  /**
   * The workspace for the operator a request's session is, or null for
   * anybody the flag does not confirm, an identity that fails included.
   */
  open(cookie: string | undefined): Promise<Workspace | null>;
}

export function workspaceDoorFor(parts: AdminParts): WorkspaceDoor {
  const merchants = merchantsFor(parts);
  const orders = ordersFor(parts);
  const figures = figuresFor(parts);
  const accounts = accountsFor(parts);
  const admin: AdminServices = {
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
  return {
    async open(cookie) {
      const operator = await operatorOf(parts.identity, cookie);
      return operator === null ? null : { admin, operator };
    },
  };
}
