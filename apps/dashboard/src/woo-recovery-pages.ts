/**
 * Merchant recovery stays inside the connector. It creates a shop order only
 * for a download its shop never received, and only once.
 */
import type { OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import type { Person } from "./dashboard-entry.js";
import type { Acting, GatewayClient } from "./gateway.js";
import { type Outcome, problemOf } from "./page-services.js";
import {
  matchesSavedWooSale,
  ownWooRecoveryOrder,
  type RecoveryGateway,
  recoverWooOrderAs,
  type WooRecoveryParts,
} from "./woo-recovery.js";
import { money } from "./words.js";

export interface WooRecoveryView {
  readonly orderId: string;
  /** The card's title, as Orders names the same sale; its product code where no card has it. */
  readonly product: string;
  readonly shopOrigin: string;
  readonly amount: string;
  /** `create` is offered once, for a download its shop never received. */
  readonly mode: "create" | "link" | "retry" | "delivered" | "unavailable";
  readonly wooOrderId: string;
  /** What became of the last press, about the sale as a whole. */
  readonly message: string | null;
  /**
   * What the last press did is not known, so the page is read again before
   * anything is pressed: a second press could repeat what the first did.
   */
  readonly unknown: boolean;
  /** Why nothing can be done here, and where the merchant goes instead. */
  readonly unavailable: Unavailable | null;
  /** Why the shop order ID just typed was refused, said under its box. */
  readonly typedRefusal: string | null;
}

/**
 * Why nothing can be done here. `shopOrder` is what is known of the shop's
 * order for the sale: the shop never got one, nobody knows whether it holds
 * one, or the one it holds. Closing fulfillment is on Orders; a shop is
 * connected again on the WooCommerce page; a parcel is followed by its shop's
 * Completed; an order no longer waiting needs nothing.
 */
export interface Unavailable {
  readonly shopOrder: "none" | "unknown" | { readonly id: string };
  readonly instead: "close" | "reconnect" | "parcel" | "nothing";
}

export interface WooRecoveryPages {
  page(person: Person, orderId: string): Promise<Outcome<WooRecoveryView>>;
  recover(person: Person, orderId: string, form: FormData): Promise<Outcome<WooRecoveryView>>;
}

export type WooRecoveryPageParts = Omit<WooRecoveryParts, "gatewayFor"> & {
  readonly gatewayFor: (acting: Acting) => RecoveryGateway & Pick<GatewayClient, "cards">;
};

type RecoveryOrder = NonNullable<Awaited<ReturnType<typeof ownWooRecoveryOrder>>>;
type Known = {
  readonly kind: "known";
  readonly record: RecoveryOrder;
  readonly order: OrderWithStatus;
  readonly title: string;
  /**
   * Whether the shop that refused is connected again under a new grant, the
   * one condition a create waits for; read only for a refused download.
   */
  readonly reconnected: boolean;
};

const modeOf = ({ record, order, reconnected }: Known): WooRecoveryView["mode"] => {
  if (record.facts.kind !== "parcel" && record.phase === "placed" && order.status === "delivered") {
    return "delivered";
  }
  if (
    record.facts.kind === "parcel" ||
    (record.phase === "precreate_refused" && !reconnected) ||
    (record.phase === "placed" && record.placed?.permission == null) ||
    order.status !== "unfulfilled"
  ) {
    return "unavailable";
  }
  return record.phase === "precreate_refused"
    ? "create"
    : record.phase === "placed"
      ? "retry"
      : "link";
};

/** What of a saved sale decides why nothing can be done for it here. */
export interface SavedSale {
  readonly facts: Pick<RecoveryOrder["facts"], "kind">;
  readonly phase: RecoveryOrder["phase"];
  readonly placed: Pick<NonNullable<RecoveryOrder["placed"]>, "id" | "permission"> | null;
}

/**
 * Why nothing can be done here, said in place of a form. It is read from the
 * saved sale and its order's status alone, so a reload says the same as the
 * press that led here.
 */
export const unavailableOf = (
  record: SavedSale,
  status: OrderWithStatus["status"],
): Unavailable => {
  const waiting = status === "unfulfilled";
  const shopOrder: Unavailable["shopOrder"] =
    record.placed !== null
      ? { id: record.placed.id }
      : record.phase === "create_unknown"
        ? "unknown"
        : "none";
  if (record.facts.kind === "parcel") {
    if (record.phase === "precreate_refused" && waiting) return { shopOrder, instead: "close" };
    if (record.phase === "create_unknown") {
      return { shopOrder, instead: waiting ? "close" : "nothing" };
    }
    return { shopOrder, instead: "parcel" };
  }
  if (record.phase === "placed" && record.placed?.permission == null) {
    return { shopOrder, instead: "close" };
  }
  return { shopOrder, instead: waiting ? "reconnect" : "nothing" };
};

/** Said where what a press did is not known; the page then asks for a reload, not a press. */
export const RECOVERY_UNKNOWN =
  "We don't know if this worked: a shop order or a delivery may already be recorded. Reload to see where it stands.";

const viewOf = (
  known: Known,
  said: Readonly<{
    message?: string | null;
    unknown?: boolean;
    typedRefusal?: string | null;
    typed?: string;
  }> = {},
): WooRecoveryView => {
  const mode = modeOf(known);
  return {
    orderId: known.record.orderId,
    product: known.title,
    shopOrigin: known.record.facts.shopOrigin,
    amount: money({ amount: known.record.facts.amount, currency: known.record.facts.currency }),
    mode,
    wooOrderId: known.record.placed?.id ?? said.typed ?? "",
    message: said.message ?? null,
    unknown: said.unknown ?? false,
    unavailable: mode === "unavailable" ? unavailableOf(known.record, known.order.status) : null,
    typedRefusal: said.typedRefusal ?? null,
  };
};

export function wooRecoveryPagesFor(parts: WooRecoveryPageParts): WooRecoveryPages {
  const missing: Outcome<never> = {
    kind: "problem",
    problem: { status: 404, said: "No recoverable WooCommerce order has that id." },
  };
  const read = async (person: Person, orderId: string): Promise<Known | Outcome<never>> => {
    const record = await ownWooRecoveryOrder(person, orderId, parts.shops);
    if (record === null || person.merchant === null) return missing;
    const gateway = parts.gatewayFor({ merchantId: person.merchant.id, email: person.email });
    const [state, cards] = await Promise.all([gateway.getOrder(orderId), gateway.cards()]);
    if (!state.ok) return problemOf(state);
    if (!matchesSavedWooSale(state.document, record.facts, orderId)) {
      return {
        kind: "problem",
        problem: {
          status: 409,
          said: "The Agentify order does not match the saved WooCommerce sale.",
        },
      };
    }
    // A title that cannot be read is no reason to withhold recovery: the
    // product code names the same product.
    const title = cards.ok
      ? cards.document.cards.find(
          (entry) => entry.card.merchant_item_id === record.facts.merchantItemId,
        )?.card.title
      : undefined;
    const connection =
      record.phase === "precreate_refused"
        ? await parts.shops.connectionOf(record.accountId)
        : null;
    return {
      kind: "known",
      record,
      order: state.document,
      title: title ?? record.facts.merchantItemId,
      reconnected:
        connection !== null &&
        new URL(connection.shopUrl).origin === record.facts.shopOrigin &&
        connection.revision !== record.facts.connectionRevision &&
        connection.permissions === "read_write",
    };
  };
  return {
    async page(person, orderId) {
      const known = await read(person, orderId);
      return known.kind === "known" ? { kind: "view", view: viewOf(known) } : known;
    },
    async recover(person, orderId, form) {
      const known = await read(person, orderId);
      if (known.kind !== "known") return known;
      const mode = modeOf(known);
      const values = form.getAll("woo_order_id");
      const typed = values.length === 1 && typeof values[0] === "string" ? values[0].trim() : "";
      if (values.length > 1 || (mode === "link" && !/^[1-9][0-9]*$/.test(typed))) {
        return {
          kind: "view",
          status: 400,
          view: viewOf(known, {
            typedRefusal:
              "Enter the number from the order's address in WooCommerce, the one after id= or post=.",
            typed,
          }),
        };
      }
      if (mode === "delivered" && (typed === "" || typed === known.record.placed?.id)) {
        return { kind: "view", view: viewOf(known) };
      }
      // Every other press, one this page offers no form for included, is
      // decided by the recovery itself, which turns away what it cannot do.
      let said: { message?: string; unknown?: boolean; typedRefusal?: string } = {};
      let status = 200;
      try {
        const outcome = await recoverWooOrderAs(
          person,
          { orderId, ...(typed === "" ? {} : { wooOrderId: typed }) },
          parts,
        );
        if (!outcome.ok) {
          said = outcome.typed === true ? { typedRefusal: outcome.why } : { message: outcome.why };
          status = outcome.state === "unresolved" ? 503 : 409;
        }
      } catch {
        said = { message: RECOVERY_UNKNOWN, unknown: true };
        status = 503;
      }
      const after = await read(person, orderId);
      if (after.kind !== "known") {
        const saved = await ownWooRecoveryOrder(person, orderId, parts.shops);
        if (saved === null) return missing;
        return {
          kind: "view",
          status: 503,
          view: viewOf(
            { ...known, record: saved, reconnected: false },
            {
              message:
                saved.placed === null
                  ? "We couldn't read the result, so we don't know if anything was recorded. Reload to see where it stands."
                  : `Shop order ${saved.placed.id} is linked, but we couldn't read whether its download was delivered. Reload to check.`,
              unknown: true,
              typed,
            },
          ),
        };
      }
      const now = modeOf(after);
      if (now === "delivered") return { kind: "view", view: viewOf(after) };
      if (now === "unavailable") {
        // The saved sale says what became of the shop order; a press adds only
        // that its own end is unknown.
        return {
          kind: "view",
          status: after.record.phase === known.record.phase && said.unknown !== true ? 409 : status,
          view: viewOf(
            after,
            said.unknown === true ? { message: said.message ?? null, unknown: true } : {},
          ),
        };
      }
      const created =
        known.record.phase === "precreate_refused" && after.record.placed != null
          ? `Your shop created order ${after.record.placed.id}. `
          : "";
      // Only the linking form has a box to say a refusal under.
      const told =
        now === "link"
          ? said
          : {
              message:
                said.message === undefined
                  ? (said.typedRefusal ?? null)
                  : `${created}${said.message}`,
              unknown: said.unknown ?? false,
              typedRefusal: null,
            };
      return { kind: "view", status, view: viewOf(after, { ...told, typed }) };
    },
  };
}
