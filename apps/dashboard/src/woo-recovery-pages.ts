/** Merchant recovery stays inside the connector and never creates a shop order. */
import type { OrderWithStatus } from "@nuanu-ai/agentify-contracts";
import type { Person } from "./dashboard-entry.js";
import { type Outcome, problemOf } from "./page-services.js";
import {
  type MerchantWooRecoveryParts,
  matchesSavedWooSale,
  ownWooRecoveryOrder,
  recoverWooOrderAs,
} from "./woo-recovery.js";
import { money } from "./words.js";

export interface WooRecoveryView {
  readonly orderId: string;
  readonly product: string;
  readonly shopOrigin: string;
  readonly amount: string;
  readonly test: boolean;
  readonly mode: "link" | "retry" | "delivered" | "unavailable";
  readonly wooOrderId: string;
  readonly message: string | null;
}

export interface WooRecoveryPages {
  page(person: Person, orderId: string): Promise<Outcome<WooRecoveryView>>;
  recover(person: Person, orderId: string, form: FormData): Promise<Outcome<WooRecoveryView>>;
}

type RecoveryOrder = NonNullable<Awaited<ReturnType<typeof ownWooRecoveryOrder>>>;
type Known = {
  readonly kind: "known";
  readonly record: RecoveryOrder;
  readonly order: OrderWithStatus;
};

const viewOf = (known: Known, message: string | null = null, typed = ""): WooRecoveryView => {
  const { record, order } = known;
  const available = order.status === "refund_due";
  const delivered =
    record.facts.kind !== "parcel" && record.phase === "placed" && order.status === "delivered";
  const mode = delivered
    ? "delivered"
    : record.facts.kind === "parcel" ||
        record.phase === "precreate_refused" ||
        (record.phase === "placed" && record.placed?.permission == null) ||
        !available
      ? "unavailable"
      : record.phase === "placed"
        ? "retry"
        : "link";
  return {
    orderId: record.orderId,
    product: record.facts.merchantItemId,
    shopOrigin: record.facts.shopOrigin,
    amount: money({ amount: record.facts.amount, currency: record.facts.currency }),
    test: order.test,
    mode,
    wooOrderId: record.placed?.id ?? typed,
    message:
      message ??
      (mode === "delivered"
        ? "Agentify confirms that this download was delivered."
        : mode === "unavailable"
          ? record.facts.kind === "parcel"
            ? "This recovery is for downloads. Parcel orders keep their existing shipping rules; this page cannot recreate an erased delivery address."
            : record.phase === "precreate_refused"
              ? "The shop was not asked to create this order. Creating a shop order is not available on this recovery page."
              : record.phase === "placed" && record.placed?.permission == null
                ? "The saved shop order has no verified download to retry. No delivery can be sent from this page."
                : "This order is not awaiting a late delivery. No recovery is available here."
          : null),
  };
};

export function wooRecoveryPagesFor(parts: MerchantWooRecoveryParts): WooRecoveryPages {
  const missing: Outcome<never> = {
    kind: "problem",
    problem: { status: 404, said: "No recoverable WooCommerce order has that id." },
  };
  const read = async (person: Person, orderId: string): Promise<Known | Outcome<never>> => {
    const record = await ownWooRecoveryOrder(person, orderId, parts.shops);
    if (record === null || person.merchant === null) return missing;
    const gateway = parts.gatewayFor({ merchantId: person.merchant.id, email: person.email });
    const state = await gateway.getOrder(orderId);
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
    return { kind: "known", record, order: state.document };
  };
  return {
    async page(person, orderId) {
      const known = await read(person, orderId);
      return known.kind === "known" ? { kind: "view", view: viewOf(known) } : known;
    },
    async recover(person, orderId, form) {
      const known = await read(person, orderId);
      if (known.kind !== "known") return known;
      const view = viewOf(known);
      if (view.mode === "unavailable") return { kind: "view", status: 409, view };
      const values = form.getAll("woo_order_id");
      const typed = values.length === 1 && typeof values[0] === "string" ? values[0].trim() : "";
      if (values.length > 1 || (view.mode === "link" && !/^[1-9][0-9]*$/.test(typed))) {
        return {
          kind: "view",
          status: 400,
          view: viewOf(
            known,
            "Enter the exact numeric WooCommerce order ID, which can differ from its displayed order number.",
            typed,
          ),
        };
      }
      if (view.mode === "delivered" && (typed === "" || typed === view.wooOrderId)) {
        return { kind: "view", view };
      }
      let message: string;
      let status = 200;
      try {
        const outcome = await recoverWooOrderAs(
          person,
          {
            orderId,
            ...(typed === "" ? {} : { wooOrderId: typed }),
          },
          parts,
        );
        message = outcome.ok ? "Agentify confirms that this download was delivered." : outcome.why;
        if (!outcome.ok) status = outcome.state === "unresolved" ? 503 : 409;
      } catch {
        message =
          "The recovery result is unknown. A saved shop order or delivery may already have been recorded. Reload this page before trying again.";
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
            saved.placed === null
              ? "The recovery result could not be read. Reload this page before deciding whether anything was recorded."
              : "The delivery result could not be read. The linked shop order shown here is saved; reload this page to check delivery before trying again.",
            typed,
          ),
        };
      }
      if (viewOf(after).mode === "delivered") {
        return { kind: "view", view: viewOf(after) };
      }
      return { kind: "view", status, view: viewOf(after, message, typed) };
    },
  };
}
