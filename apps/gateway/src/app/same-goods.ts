import type { Delivery } from "@nuanu-ai/agentify-contracts";

/** A document as one string, its keys sorted at every depth, so order says nothing. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );
}

/**
 * Whether two deliveries carry the same goods, whatever order their keys come
 * in. A parcel's shipment is compared without `shipped_at`, which this
 * gateway stamps with the moment it recorded each one.
 */
export function sameGoods(kept: Delivery, sent: Delivery, parcel: boolean): boolean {
  if (!parcel) return canonical(kept) === canonical(sent);
  const { shipped_at: _stamped, ...recorded } = kept;
  const { shipped_at: _echoed, ...said } = sent;
  return canonical(recorded) === canonical(said);
}
