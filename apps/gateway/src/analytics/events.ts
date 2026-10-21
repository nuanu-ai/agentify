/**
 * The product analytics contract `commerce-v1`: the ten events Agentify's
 * server records about the cabinet, setup, publishing and orders, with every
 * field each one carries and the values a field may take. Nothing else leaves:
 * no name, address, wallet, key, free text or content of a card or an order.
 *
 * An event names what it concerns by raw identifiers, its `refs`, which stay
 * in Agentify's database and leave only as keyed hashes. `person` is the
 * dashboard account that acted, and is sent as the user only when the actor
 * is `human`.
 */

const REASON_CODES = [
  "invalid_input",
  "invalid_link",
  "session_expired",
  "identity_mismatch",
  "rate_limited",
  "profile_missing",
  "wallet_missing",
  "approval_required",
  "seller_site_missing",
  "integration_mismatch",
  "unsupported_channel",
  "no_connection",
  "catalogue_unavailable",
  "payment_not_settled",
  "merchant_refused",
  "merchant_unavailable",
  "deadline_expired",
  "operation_closed",
  "dependency_unavailable",
  "timeout",
  "internal_error",
  "unknown",
] as const;
type ReasonCode = (typeof REASON_CODES)[number];

const ACTOR_TYPES = [
  "human",
  "buyer_agent",
  "merchant_worker",
  "system",
  "operator",
  "unknown",
] as const;
type ActorType = (typeof ACTOR_TYPES)[number];

const SOURCES = ["dashboard", "gateway", "woocommerce"] as const;
type Source = (typeof SOURCES)[number];

const SCREENS = [
  "sign_in",
  "merchant",
  "choose_name",
  "cards",
  "orders",
  "receipts",
  "integrations",
  "settings",
  "payout_wallet",
  "keys",
  "woocommerce",
] as const;
type Screen = (typeof SCREENS)[number];

const FAILED = ["blocked", "failed", "unknown"] as const;
type Failed = (typeof FAILED)[number];
const AUTH_METHODS = ["email_link", "google"] as const;
const SETUP_INTEGRATIONS = ["api", "woocommerce", "none"] as const;
const INTEGRATIONS = ["api", "woocommerce"] as const;
type Integration = (typeof INTEGRATIONS)[number];
const BLOCKING_OPERATIONS = [
  "load_screen",
  "create_merchant",
  "change_selling",
  "close_order",
  "wallet_provider",
] as const;
const MONEY_MODES = ["real", "test"] as const;
type MoneyMode = (typeof MONEY_MODES)[number];
const NETWORKS = ["base", "base_sepolia", "other", "unknown"] as const;
type Network = (typeof NETWORKS)[number];
const PAYMENT_STATES = ["paid", "not_paid", "unresolved"] as const;
type PaymentState = (typeof PAYMENT_STATES)[number];
const ORDER_OUTCOMES = [
  "delivered",
  "shipped",
  "rejected",
  "declined",
  "expired",
  "cancelled",
  "unfulfilled",
  "fulfillment_closed",
  "delivered_unpaid",
  "in_progress",
] as const;
const CHANGES = ["paused", "resumed"] as const;

/** Who an event is about; either may be absent where it is not known. */
interface Who {
  readonly merchant?: string;
  readonly person?: string;
}

interface Envelope<Name extends string> {
  readonly name: Name;
  readonly actor: ActorType;
  readonly source: Source;
}

/** An outcome that was reached, or one that was not and says why. */
type Settled<Reached extends string> =
  | { readonly outcome: Reached; readonly reason_code?: never }
  | { readonly outcome: Failed; readonly reason_code: ReasonCode };

/** A1: a screen of the cabinet a person was shown. */
export type DashboardViewed = Envelope<"agc_dashboard_viewed"> & {
  readonly refs?: Who;
  readonly fields: { readonly screen: Screen };
};

/**
 * A2: a sign-in confirmed at verification, `first_verification` true only for
 * the address's first, or one refused or failed at its start or verification.
 */
export type AuthResult = Envelope<"agc_auth_result"> &
  (
    | {
        readonly actor: "human";
        readonly refs: Who & { readonly person: string };
        readonly fields: {
          readonly method: (typeof AUTH_METHODS)[number];
          readonly stage: "verify";
          readonly outcome: "confirmed";
          readonly first_verification: boolean;
        };
      }
    | {
        readonly refs?: Who;
        readonly fields: {
          readonly method: (typeof AUTH_METHODS)[number];
          readonly stage: "start" | "verify";
          readonly outcome: Failed;
          readonly reason_code: ReasonCode;
        };
      }
  );

/** A3: a new merchant attached to the person who created it. */
export type MerchantCreated = Envelope<"agc_merchant_created"> & {
  readonly actor: "human";
  readonly refs: { readonly merchant: string; readonly person: string };
  readonly fields?: Readonly<Record<string, never>>;
};

type SetupIntegration = (typeof SETUP_INTEGRATIONS)[number];

/**
 * A4: the outcome of one setup step. Only a payout wallet's change waits
 * (`pending`), only an import is `partial` and counts products, and live sales
 * are granted by the operator alone.
 */
export type SetupResult = Envelope<"agc_setup_result"> & {
  readonly refs?: Who;
} & (
    | {
        readonly actor: "operator";
        readonly fields: {
          readonly step: "live_approval";
          readonly integration: SetupIntegration;
        } & Settled<"completed">;
      }
    | {
        readonly fields: {
          readonly step: "seller_name" | "seller_site" | "api_key" | "woo_connection";
          readonly integration: SetupIntegration;
        } & Settled<"completed">;
      }
    | {
        readonly fields: {
          readonly step: "payout_wallet";
          readonly integration: SetupIntegration;
        } & Settled<"completed" | "pending">;
      }
    | {
        readonly fields: {
          readonly step: "woo_import";
          readonly integration: SetupIntegration;
          readonly imported_count: number;
          readonly failed_count: number;
          readonly skipped_count: number;
        } & Settled<"completed" | "partial">;
      }
  );

/** A5: a new card's first publication, or a publication that did not go through. */
export type CardPublishResult = Envelope<"agc_card_publish_result"> &
  (
    | {
        readonly refs: Who & { readonly item: string };
        readonly fields: {
          readonly integration: Integration;
          readonly outcome: "completed";
          readonly reason_code?: never;
        };
      }
    | {
        readonly refs?: Who & { readonly item?: string };
        readonly fields: {
          readonly integration: Integration;
          readonly outcome: Failed;
          readonly reason_code: ReasonCode;
        };
      }
  );

/** A6: a merchant or one card paused or resumed. */
export type SellingChanged = Envelope<"agc_selling_changed"> &
  (
    | {
        readonly refs?: Who;
        readonly fields: { readonly entity: "merchant"; readonly change: (typeof CHANGES)[number] };
      }
    | {
        readonly refs: Who & { readonly item: string };
        readonly fields: { readonly entity: "card"; readonly change: (typeof CHANGES)[number] };
      }
  );

/** A7: a problem shown on a screen that stopped what the person was doing. */
export type UiBlocked = Envelope<"agc_ui_blocked"> & {
  readonly refs?: Who & { readonly operation?: string };
  readonly fields: {
    readonly screen: Screen;
    readonly operation: (typeof BLOCKING_OPERATIONS)[number];
    readonly outcome: Failed;
    readonly reason_code: ReasonCode;
  };
};

/** B1: a new order recorded. */
export type OrderCreated = Envelope<"agc_order_created"> & {
  readonly refs: Who & { readonly order: string; readonly item?: string };
  readonly fields: {
    readonly integration: Integration;
    readonly money_mode: MoneyMode;
    readonly network: Network;
  };
};

/**
 * B2: a payment attempt's result. An amount, an exact decimal string, and its
 * currency go only with a payment observed paid, and are left out where the
 * amount is not known. The sender adds the event's `revision`.
 */
export type PaymentResult = Envelope<"agc_payment_result"> & {
  readonly refs: Who & { readonly order: string; readonly attempt: string };
  readonly fields:
    | ({
        readonly payment_state: "paid";
        readonly money_mode: MoneyMode;
        readonly network: Network;
        readonly reason_code?: never;
      } & (
        | { readonly amount: string; readonly currency: string }
        | { readonly amount?: never; readonly currency?: never }
      ))
    | {
        readonly payment_state: "not_paid" | "unresolved";
        readonly money_mode: MoneyMode;
        readonly network: Network;
        readonly reason_code: ReasonCode;
      };
};

/** B3: an order's outcome as the buyer sees it changed. The sender adds the `revision`. */
export type OrderOutcomeChanged = Envelope<"agc_order_outcome_changed"> & {
  readonly refs: Who & { readonly order: string };
  readonly fields: {
    readonly outcome: (typeof ORDER_OUTCOMES)[number];
    readonly payment_state: PaymentState;
    readonly money_mode: MoneyMode;
    readonly reason_code?: ReasonCode;
  };
};

export type AnalyticsEvent =
  | DashboardViewed
  | AuthResult
  | MerchantCreated
  | SetupResult
  | CardPublishResult
  | SellingChanged
  | UiBlocked
  | OrderCreated
  | PaymentResult
  | OrderOutcomeChanged;

type EventName = AnalyticsEvent["name"];

type ReferenceKind = "merchant" | "person" | "item" | "order" | "attempt" | "operation";

/** What a field holds: one of a list, or a value of a kind. */
type Rule = readonly string[] | "boolean" | "count" | "amount" | "currency";

/** One shape an event can take. Every field it names is required. */
interface Shape {
  readonly actor?: ActorType;
  readonly fields: Readonly<Record<string, Rule>>;
  readonly needs?: readonly ReferenceKind[];
  readonly may?: readonly ReferenceKind[];
}

type Fields = Readonly<Record<string, unknown>>;

/** The shape an event's fields choose, or why they choose none. */
type Chooser = (fields: Fields) => Shape | string;

const listed = (values: readonly string[]): string => values.join(", ");

/** Chooses by the value of one field, which each choice's shape requires again. */
const by =
  (key: string, choices: Readonly<Record<string, Shape | Chooser>>): Chooser =>
  (fields) => {
    const value = fields[key];
    const choice =
      typeof value === "string" && Object.hasOwn(choices, value) ? choices[value] : undefined;
    if (choice === undefined) {
      return value === undefined
        ? `properties.${key} is required`
        : `properties.${key} must be one of ${listed(Object.keys(choices))} here`;
    }
    return typeof choice === "function" ? choice(fields) : choice;
  };

const settled = (
  reached: readonly string[],
  fields: Readonly<Record<string, Rule>>,
  extra: Omit<Shape, "fields"> = {},
): Readonly<Record<string, Shape>> =>
  Object.fromEntries([
    ...reached.map((outcome) => [outcome, { ...extra, fields: { ...fields, outcome: [outcome] } }]),
    ...FAILED.map((outcome) => [
      outcome,
      { ...extra, fields: { ...fields, outcome: [outcome], reason_code: REASON_CODES } },
    ]),
  ]);

const COUNTS = { imported_count: "count", failed_count: "count", skipped_count: "count" } as const;
const PAYMENT = { money_mode: MONEY_MODES, network: NETWORKS } as const;
const PAYMENT_REFS = { needs: ["order", "attempt"] } as const;

const SHAPES: Readonly<Record<EventName, Chooser>> = {
  agc_dashboard_viewed: () => ({ fields: { screen: SCREENS } }),
  agc_auth_result: by("outcome", {
    confirmed: {
      actor: "human",
      needs: ["person"],
      fields: {
        method: AUTH_METHODS,
        stage: ["verify"],
        outcome: ["confirmed"],
        first_verification: "boolean",
      },
    },
    ...settled([], { method: AUTH_METHODS, stage: ["start", "verify"] }),
  }),
  agc_merchant_created: () => ({ actor: "human", needs: ["merchant", "person"], fields: {} }),
  agc_setup_result: by("step", {
    live_approval: by(
      "outcome",
      settled(
        ["completed"],
        { step: ["live_approval"], integration: SETUP_INTEGRATIONS },
        {
          actor: "operator",
        },
      ),
    ),
    ...Object.fromEntries(
      ["seller_name", "seller_site", "api_key", "woo_connection"].map((step) => [
        step,
        by("outcome", settled(["completed"], { step: [step], integration: SETUP_INTEGRATIONS })),
      ]),
    ),
    payout_wallet: by(
      "outcome",
      settled(["completed", "pending"], {
        step: ["payout_wallet"],
        integration: SETUP_INTEGRATIONS,
      }),
    ),
    woo_import: by(
      "outcome",
      settled(["completed", "partial"], {
        step: ["woo_import"],
        integration: SETUP_INTEGRATIONS,
        ...COUNTS,
      }),
    ),
  }),
  agc_card_publish_result: by("outcome", {
    completed: { needs: ["item"], fields: { integration: INTEGRATIONS, outcome: ["completed"] } },
    ...settled([], { integration: INTEGRATIONS }, { may: ["item"] }),
  }),
  agc_selling_changed: by("entity", {
    merchant: { fields: { entity: ["merchant"], change: CHANGES } },
    card: { needs: ["item"], fields: { entity: ["card"], change: CHANGES } },
  }),
  agc_ui_blocked: () => ({
    may: ["operation"],
    fields: {
      screen: SCREENS,
      operation: BLOCKING_OPERATIONS,
      outcome: FAILED,
      reason_code: REASON_CODES,
    },
  }),
  agc_order_created: () => ({
    needs: ["order"],
    may: ["item"],
    fields: { integration: INTEGRATIONS, ...PAYMENT },
  }),
  agc_payment_result: by("payment_state", {
    paid: (fields) =>
      "amount" in fields || "currency" in fields
        ? {
            ...PAYMENT_REFS,
            fields: { payment_state: ["paid"], ...PAYMENT, amount: "amount", currency: "currency" },
          }
        : { ...PAYMENT_REFS, fields: { payment_state: ["paid"], ...PAYMENT } },
    ...Object.fromEntries(
      ["not_paid", "unresolved"].map((state) => [
        state,
        {
          ...PAYMENT_REFS,
          fields: { payment_state: [state], ...PAYMENT, reason_code: REASON_CODES },
        },
      ]),
    ),
  }),
  agc_order_outcome_changed: (fields) => ({
    needs: ["order"],
    fields: {
      outcome: ORDER_OUTCOMES,
      payment_state: PAYMENT_STATES,
      money_mode: MONEY_MODES,
      ...("reason_code" in fields ? { reason_code: REASON_CODES } : {}),
    },
  }),
};

/** An exact decimal, such as `1.00`, never a number a reader would round. */
const AN_AMOUNT = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/;
/** A currency's code as its issuer writes it, such as `USDC`. */
const A_CURRENCY = /^[A-Z][A-Z0-9]{1,11}$/;
/** Long enough for any identifier Agentify makes, short enough to be one. */
const LONGEST_REFERENCE = 200;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

function ruleProblem(key: string, rule: Rule, value: unknown): string | null {
  const field = `properties.${key}`;
  if (typeof rule !== "string") {
    return isOneOf(rule, value) ? null : `${field} must be one of ${listed(rule)}`;
  }
  switch (rule) {
    case "boolean":
      return typeof value === "boolean" ? null : `${field} must be true or false`;
    case "count":
      return Number.isSafeInteger(value) && (value as number) >= 0
        ? null
        : `${field} must be a whole number, zero or more`;
    case "amount":
      return typeof value === "string" && AN_AMOUNT.test(value)
        ? null
        : `${field} must be an exact decimal string such as 1.00`;
    case "currency":
      return typeof value === "string" && A_CURRENCY.test(value)
        ? null
        : `${field} must be a currency's code such as USDC`;
  }
}

/** An event as the outbox holds it, whatever its columns came to contain. */
export interface StoredEvent {
  readonly name: string;
  readonly actor: string;
  readonly source: string;
  readonly refs: unknown;
  readonly fields: unknown;
}

/**
 * The event a stored row holds if it keeps the contract, or the first thing
 * about it that does not, naming the field: a property, a reference, the
 * actor or the source. Nothing is thrown.
 */
export function checkedEvent(
  row: StoredEvent,
): Readonly<{ event: AnalyticsEvent }> | Readonly<{ problem: string }> {
  const problem = problemOf(row);
  return problem === null ? { event: row as unknown as AnalyticsEvent } : { problem };
}

function problemOf(row: StoredEvent): string | null {
  const chooser = Object.hasOwn(SHAPES, row.name) ? SHAPES[row.name as EventName] : undefined;
  if (chooser === undefined) return `${row.name} is not an event of the contract`;
  if (!isOneOf(ACTOR_TYPES, row.actor)) return `actor_type must be one of ${listed(ACTOR_TYPES)}`;
  if (!isOneOf(SOURCES, row.source)) return `source must be one of ${listed(SOURCES)}`;
  const { fields, refs } = row;
  if (!isRecord(fields)) return "properties must be an object";
  if (!isRecord(refs)) return "refs must be an object";

  const shape = chooser(fields);
  if (typeof shape === "string") return shape;
  if (shape.actor !== undefined && row.actor !== shape.actor) {
    return `actor_type must be ${shape.actor} for this ${row.name}`;
  }

  for (const [key, rule] of Object.entries(shape.fields)) {
    if (!Object.hasOwn(fields, key)) {
      return key === "amount" || key === "currency"
        ? "properties.amount and properties.currency go together"
        : `properties.${key} is required`;
    }
    const problem = ruleProblem(key, rule, fields[key]);
    if (problem !== null) return problem;
  }
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(shape.fields, key)) {
      return `properties.${key} is not carried by this ${row.name}`;
    }
  }

  const needs = shape.needs ?? [];
  const allowed = new Set<string>(["merchant", "person", ...needs, ...(shape.may ?? [])]);
  for (const kind of needs) {
    if (!Object.hasOwn(refs, kind)) return `refs.${kind} is required`;
  }
  for (const [kind, value] of Object.entries(refs)) {
    if (!allowed.has(kind)) return `refs.${kind} is not carried by this ${row.name}`;
    if (typeof value !== "string" || value === "" || value.length > LONGEST_REFERENCE) {
      return `refs.${kind} must be an identifier`;
    }
  }
  return null;
}
