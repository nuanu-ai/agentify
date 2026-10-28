import { transition } from "@agentify/core";
import type { ShipTo } from "@nuanu-ai/agentify-contracts";
import type { Gateway, PricedPurchase } from "../app/gateway.js";
import type { PaymentRecoveryContext } from "../ports/facilitator.js";
import type { Store, StoredOrder } from "../ports/store.js";

/** Stores an already-owned history through the real atomic admission boundary. */
export async function storeAcceptedOrder(store: Store, record: StoredOrder): Promise<void> {
  if (record.paidBy === null || record.order.state === "created" || record.order.state === "quoted")
    throw new Error("An accepted-order fixture needs its verified owner and an accepted state.");
  const merchant = await store.merchantById(record.merchantId);
  if (merchant === null) throw new Error("The accepted-order fixture has no merchant.");
  const admitted = await store.admitOrder({
    record,
    standing: () => "stands",
    birth: { through: record.through ?? merchant.integration },
    fingerprint: record.paymentFingerprint ?? `accepted-fixture:${record.order.id}`,
    alongside: [],
    analytics: [],
  });
  if (admitted.kind !== "admitted" && admitted.kind !== "existing")
    throw new Error(`Fixture admission was ${admitted.kind}.`);
}

/** Starts at verified payment, then uses the production preparation, commit and effects. */
export async function admitVerifiedOrder(
  gateway: Gateway,
  offer: PricedPurchase,
  verified: {
    readonly owner: string;
    readonly payment: string;
    readonly fingerprint: string;
    readonly payTo?: string;
    readonly recovery?: PaymentRecoveryContext;
    readonly shipTo?: ShipTo;
  },
): Promise<void> {
  const arrived = transition(offer.order, {
    kind: "payment_presented",
    at: gateway.runtime.clock(),
  });
  if (!arrived.ok) throw new Error("The verified fixture arrived outside its price term.");
  const record: StoredOrder = {
    ...offer,
    order: arrived.order,
    buyerKey: gateway.runtime.ids("bk"),
    delivery: null,
    payment: null,
    payTo: null,
    paidBy: null,
    settlement: null,
    paymentWords: [],
    paymentWordsDropped: 0,
    openDeliveryId: null,
  };
  const prepared = gateway.runner.preparePurchase(
    record,
    verified.owner,
    verified.payment,
    verified.payTo ?? offer.priceOffer.requirements.payTo,
    gateway.runtime.clock(),
    {
      fingerprint: verified.fingerprint,
      standing: (merchant, card) =>
        merchant.id === offer.merchantId && card?.id === offer.itemId ? "stands" : "off_sale",
      ...(verified.recovery === undefined ? {} : { recovery: verified.recovery }),
      ...(verified.shipTo === undefined ? {} : { shipTo: verified.shipTo }),
    },
  );
  if (!prepared.ok)
    throw new Error(`Verified fixture preparation failed: ${prepared.rejection.message}`);
  const committed = await gateway.runtime.store.admitOrder(prepared.prepared.accept);
  if (committed.kind !== "admitted")
    throw new Error(`Verified fixture admission was ${committed.kind}.`);
  await gateway.runner.finishAdmission(prepared.prepared);
}
