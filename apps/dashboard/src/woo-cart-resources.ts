/** Cart identity ownership and creation permission, shared by every connection to one shop. */
import { createHash } from "node:crypto";
export type WooCartLane = "paid" | "quote";
interface EmptyWooCart {
  readonly token: string;
  readonly expiresAt: Date | null;
}
export type WooCartClaim =
  | { readonly kind: "new" }
  | ({ readonly kind: "reuse" } & EmptyWooCart)
  | { readonly kind: "wait"; readonly retryAt: Date }
  | { readonly kind: "stale" };

export interface WooCartResources {
  startCartRuntime(shopUrl: string, owner: string): Promise<void>;
  claimCart(
    shopUrl: string,
    owner: string,
    lane: WooCartLane,
    slot: number,
    claim: string,
    now: Date,
  ): Promise<WooCartClaim>;
  finishCart(
    shopUrl: string,
    owner: string,
    lane: WooCartLane,
    slot: number,
    claim: string,
    empty: EmptyWooCart | null,
  ): Promise<boolean>;
  registerCartIdentity(
    shopUrl: string,
    owner: string,
    lane: WooCartLane,
    slot: number,
    claim: string,
    token: string,
  ): Promise<boolean>;
}

interface ResourceSlot {
  /** The shop issued this slot a session, so the next one it opens needs the replacement budget. */
  initialized: boolean;
  state: "empty" | "idle" | "in_use" | "retired";
  claim: string | null;
  token: string | null;
  identity: string | null;
  expiresAt: number | null;
}
export interface WooCartResourceState {
  owner: string;
  nextCreationAt: number;
  slots: ResourceSlot[];
}

// Four handlers can each calculate the destination and the shop's tax base concurrently.
export const WOO_CARTS_PER_LANE = 8;
const WOO_CART_REPLACEMENT_MS = 600_000;
export const emptyCartResources = (): WooCartResourceState => ({
  owner: "",
  nextCreationAt: 0,
  slots: Array.from({ length: WOO_CARTS_PER_LANE * 2 }, () => ({
    initialized: false,
    state: "empty",
    claim: null,
    token: null,
    identity: null,
    expiresAt: null,
  })),
});

export type CartResourceAccess = <T>(
  origin: string,
  change: (state: WooCartResourceState) => T,
  fence?: CartResourceFence<T>,
) => Promise<T>;

export interface CartResourceFence<T> {
  readonly owner: string;
  readonly claim?: { readonly lane: WooCartLane; readonly slot: number; readonly id: string };
  readonly stale: T;
}

const slotOf = (state: WooCartResourceState, lane: WooCartLane, index: number): ResourceSlot => {
  if (!Number.isInteger(index) || index < 0 || index >= WOO_CARTS_PER_LANE)
    throw new Error("Invalid WooCommerce cart slot.");
  const slot = state.slots[(lane === "paid" ? 0 : WOO_CARTS_PER_LANE) + index];
  if (slot === undefined) throw new Error("The WooCommerce cart registry is incomplete.");
  return slot;
};
const retire = (slot: ResourceSlot): void => {
  slot.state = "retired";
  slot.token = null;
  slot.expiresAt = null;
  slot.claim = null;
};

/** JWT refresh changes token bytes while its issuing shop keeps the same session. */
const identityOf = (token: string): string => {
  let identity = `token:${token}`;
  try {
    const parts = token.split(".");
    const payload: unknown =
      parts.length === 3 && token.length <= 8192
        ? JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"))
        : null;
    if (
      typeof payload === "object" &&
      payload !== null &&
      "user_id" in payload &&
      typeof payload.user_id === "string" &&
      payload.user_id !== ""
    )
      identity = `user:${payload.user_id}`;
  } catch {
    /* Opaque tokens identify their session by their exact bytes. */
  }
  return createHash("sha256").update(identity).digest("hex");
};

const registerIdentity = (
  state: WooCartResourceState,
  lane: WooCartLane,
  index: number,
  token: string,
): boolean => {
  const slot = slotOf(state, lane, index);
  const identity = identityOf(token);
  if (state.slots.some((other) => other !== slot && other.identity === identity)) return false;
  // A replacement may never reopen its predecessor. An active identity may refresh only its own token.
  if (
    slot.identity !== null &&
    (slot.token === null ? slot.identity === identity : slot.identity !== identity)
  )
    return false;
  slot.identity = identity;
  slot.token = token;
  slot.initialized = true;
  return true;
};

/** Checked against stored metadata before any token decryption or normalization. */
export const ownsCartResources = <T>(
  state: WooCartResourceState,
  fence: CartResourceFence<T>,
): boolean => {
  if (state.owner !== fence.owner) return false;
  if (fence.claim === undefined) return true;
  const slot = slotOf(state, fence.claim.lane, fence.claim.slot);
  return slot.state === "in_use" && slot.claim === fence.claim.id;
};

export const wooCartResources = (access: CartResourceAccess): WooCartResources => ({
  startCartRuntime: (shopUrl, owner) =>
    access(new URL(shopUrl).origin, (state) => {
      if (state.owner === owner) return;
      for (const slot of state.slots) if (slot.state === "in_use") retire(slot);
      state.owner = owner;
    }),
  claimCart: (shopUrl, owner, lane, index, claim, now) =>
    access(
      new URL(shopUrl).origin,
      (state): WooCartClaim => {
        const slot = slotOf(state, lane, index);
        if (slot.state === "in_use")
          return { kind: "wait", retryAt: new Date(now.getTime() + 250) };
        if (
          slot.state === "idle" &&
          slot.token !== null &&
          (slot.expiresAt === null || slot.expiresAt > now.getTime())
        ) {
          slot.state = "in_use";
          slot.claim = claim;
          return {
            kind: "reuse",
            token: slot.token,
            expiresAt: slot.expiresAt === null ? null : new Date(slot.expiresAt),
          };
        }
        if (slot.state === "idle") retire(slot);
        if (slot.initialized && state.nextCreationAt > now.getTime())
          return { kind: "wait", retryAt: new Date(state.nextCreationAt) };
        if (slot.initialized) state.nextCreationAt = now.getTime() + WOO_CART_REPLACEMENT_MS;
        slot.state = "in_use";
        slot.claim = claim;
        slot.token = null;
        slot.expiresAt = null;
        return { kind: "new" };
      },
      { owner, stale: { kind: "stale" } },
    ),
  finishCart: (shopUrl, owner, lane, index, claim, empty) =>
    access(
      new URL(shopUrl).origin,
      (state): boolean => {
        const slot = slotOf(state, lane, index);
        if (empty === null) retire(slot);
        else {
          if (!registerIdentity(state, lane, index, empty.token)) return false;
          slot.state = "idle";
          slot.token = empty.token;
          slot.expiresAt = empty.expiresAt?.getTime() ?? null;
          slot.claim = null;
        }
        return true;
      },
      { owner, claim: { lane, slot: index, id: claim }, stale: false },
    ),
  registerCartIdentity: (shopUrl, owner, lane, index, claim, token) =>
    access(
      new URL(shopUrl).origin,
      (state): boolean => registerIdentity(state, lane, index, token),
      { owner, claim: { lane, slot: index, id: claim }, stale: false },
    ),
});

export const memoryCartResources = (): WooCartResources => {
  const rows = new Map<string, WooCartResourceState>();
  return wooCartResources(async (origin, change, fence) => {
    let state = rows.get(origin);
    if (fence !== undefined && (state === undefined || !ownsCartResources(state, fence)))
      return fence.stale;
    if (state === undefined) {
      state = emptyCartResources();
      rows.set(origin, state);
    }
    return change(state);
  });
};
