/** Merchant recovery stays inside the connector and never creates a shop order. */
import type { OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import type { Person } from "./dashboard-entry.js";
import type { Acting, GatewayClient } from "./gateway.js";
import { type Outcome, problemOf } from "./page-services.js";
import {
  type MerchantWooRecoveryParts,
  matchesSavedWooSale,
  ownWooRecoveryOrder,
  type RecoveryGateway,
  recoverWooOrderAs,
} from "./woo-recovery.js";
import { money } from "./words.js";

export interface WooRecoveryView {
  readonly orderId: string;
  /** The card's title, as Orders names the same sale; its product code where no card has it. */
  readonly product: string;
  readonly shopOrigin: string;
  readonly amount: string;
  readonly test: boolean;
  readonly mode: "link" | "retry" | "delivered" | "unavailable";
  readonly wooOrderId: string;
  /** What became of the page or the last press, about the sale as a whole. */
  readonly message: string | null;
  /** Why the WooCommerce order ID just typed was refused, said under its box. */
  readonly typedRefusal: string | null;
}

export interface WooRecoveryPages {
  page(person: Person, orderId: string): Promise<Outcome<WooRecoveryView>>;
  recover(person: Person, orderId: string, form: FormData): Promise<Outcome<WooRecoveryView>>;
}

export type WooRecoveryPageParts = Omit<MerchantWooRecoveryParts, "gatewayFor"> & {
  readonly gatewayFor: (acting: Acting) => RecoveryGateway & Pick<GatewayClient, "cards">;
};

type RecoveryOrder = NonNullable<Awaited<ReturnType<typeof ownWooRecoveryOrder>>>;
type Known = {
  readonly kind: "known";
  readonly record: RecoveryOrder;
  readonly order: OrderWithStatus;
  readonly title: string;
};

const DELIVERED = "Agentify confirms that this download was delivered.";

const modeOf = ({ record, order }: Known): WooRecoveryView["mode"] => {
  if (record.facts.kind !== "parcel" && record.phase === "placed" && order.status === "delivered") {
    return "delivered";
  }
  if (
    record.facts.kind === "parcel" ||
    record.phase === "precreate_refused" ||
    (record.phase === "placed" && record.placed?.permission == null) ||
    order.status !== "unfulfilled"
  ) {
    return "unavailable";
  }
  return record.phase === "placed" ? "retry" : "link";
};

/** Why nothing can be done here, said in place of a form. */
const unavailableBecause = ({ record }: Known): string =>
  record.facts.kind === "parcel"
    ? "This page recovers downloads. A parcel order follows its shipping rules on the WooCommerce page."
    : record.phase === "precreate_refused"
      ? "Your shop was never asked to create this order, and this page cannot create one. To stop delivery, close fulfillment on Orders."
      : record.phase === "placed" && record.placed?.permission == null
        ? "The saved shop order has no download to send. To stop delivery, close fulfillment on Orders."
        : "This order is not waiting for a late delivery, so there is nothing to recover.";

const viewOf = (
  known: Known,
  said: Readonly<{ message?: string | null; typedRefusal?: string | null; typed?: string }> = {},
): WooRecoveryView => {
  const mode = modeOf(known);
  return {
    orderId: known.record.orderId,
    product: known.title,
    shopOrigin: known.record.facts.shopOrigin,
    amount: money({ amount: known.record.facts.amount, currency: known.record.facts.currency }),
    test: known.order.test,
    mode,
    wooOrderId: known.record.placed?.id ?? said.typed ?? "",
    message:
      said.message ??
      (mode === "delivered"
        ? DELIVERED
        : mode === "unavailable"
          ? unavailableBecause(known)
          : null),
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
    return {
      kind: "known",
      record,
      order: state.document,
      title: title ?? record.facts.merchantItemId,
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
              "Enter the order's numeric ID from its address in your shop, which can differ from its order number.",
            typed,
          }),
        };
      }
      if (mode === "delivered" && (typed === "" || typed === known.record.placed?.id)) {
        return { kind: "view", view: viewOf(known) };
      }
      // Every other press, one this page offers no form for included, is
      // decided by the recovery itself, which turns away what it cannot do.
      let said: { message?: string; typedRefusal?: string } = {};
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
        said = {
          message:
            "The recovery result is unknown. A saved shop order or delivery may already have been recorded. Reload this page before trying again.",
        };
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
            { ...known, record: saved },
            {
              message:
                saved.placed === null
                  ? "The recovery result could not be read. Reload this page before deciding whether anything was recorded."
                  : "The delivery result could not be read. The linked shop order shown here is saved; reload this page to check delivery before trying again.",
              typed,
            },
          ),
        };
      }
      const now = modeOf(after);
      if (now === "delivered") return { kind: "view", view: viewOf(after) };
      if (now === "unavailable") return { kind: "view", status: 409, view: viewOf(after) };
      // Only the linking form has a box to say a refusal under.
      const told =
        now === "link"
          ? said
          : { message: said.message ?? said.typedRefusal ?? null, typedRefusal: null };
      return { kind: "view", status, view: viewOf(after, { ...told, typed }) };
    },
  };
}
