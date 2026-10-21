/**
 * The contract every recorded event is held to before it leaves for Nuanu
 * Analytics. A row that breaks it is never sent, and the reason the sender
 * records names the field, so whoever wired the event can find it.
 */

import { describe, expect, it } from "vitest";
import {
  type AnalyticsEvent,
  type AuthResult,
  type CardPublishResult,
  checkedEvent,
  type DashboardViewed,
  type MerchantCreated,
  type OrderCreated,
  type OrderOutcomeChanged,
  type PaymentResult,
  type SellingChanged,
  type SetupResult,
  type UiBlocked,
} from "./events.js";

const viewed: DashboardViewed = {
  name: "agc_dashboard_viewed",
  actor: "human",
  source: "dashboard",
  refs: { merchant: "m-1", person: "p-1" },
  fields: { screen: "cards" },
};
const confirmed: AuthResult = {
  name: "agc_auth_result",
  actor: "human",
  source: "dashboard",
  refs: { person: "p-1" },
  fields: { method: "email_link", stage: "verify", outcome: "confirmed", first_verification: true },
};
const refusedAtStart: AuthResult = {
  name: "agc_auth_result",
  actor: "human",
  source: "dashboard",
  fields: {
    method: "email_link",
    stage: "start",
    outcome: "blocked",
    reason_code: "invalid_input",
  },
};
const created: MerchantCreated = {
  name: "agc_merchant_created",
  actor: "human",
  source: "dashboard",
  refs: { merchant: "m-1", person: "p-1" },
};
const walletSaved: SetupResult = {
  name: "agc_setup_result",
  actor: "human",
  source: "dashboard",
  refs: { merchant: "m-1", person: "p-1" },
  fields: { step: "payout_wallet", outcome: "pending", integration: "none" },
};
const imported: SetupResult = {
  name: "agc_setup_result",
  actor: "human",
  source: "woocommerce",
  refs: { merchant: "m-1", person: "p-1" },
  fields: {
    step: "woo_import",
    outcome: "partial",
    integration: "woocommerce",
    imported_count: 3,
    failed_count: 1,
    skipped_count: 0,
  },
};
const approved: SetupResult = {
  name: "agc_setup_result",
  actor: "operator",
  source: "dashboard",
  refs: { merchant: "m-1", person: "p-9" },
  fields: { step: "live_approval", outcome: "completed", integration: "api" },
};
const published: CardPublishResult = {
  name: "agc_card_publish_result",
  actor: "merchant_worker",
  source: "gateway",
  refs: { merchant: "m-1", item: "c-1" },
  fields: { integration: "api", outcome: "completed" },
};
const paused: SellingChanged = {
  name: "agc_selling_changed",
  actor: "human",
  source: "gateway",
  refs: { merchant: "m-1", person: "p-1", item: "c-1" },
  fields: { entity: "card", change: "paused" },
};
const blocked: UiBlocked = {
  name: "agc_ui_blocked",
  actor: "human",
  source: "dashboard",
  refs: { person: "p-1", operation: "o-1" },
  fields: {
    screen: "merchant",
    operation: "create_merchant",
    outcome: "failed",
    reason_code: "dependency_unavailable",
  },
};
const ordered: OrderCreated = {
  name: "agc_order_created",
  actor: "buyer_agent",
  source: "gateway",
  refs: { merchant: "m-1", order: "o-1", item: "c-1" },
  fields: { integration: "api", money_mode: "test", network: "base_sepolia" },
};
const paid: PaymentResult = {
  name: "agc_payment_result",
  actor: "buyer_agent",
  source: "gateway",
  refs: { merchant: "m-1", order: "o-1", attempt: "a-1" },
  fields: {
    payment_state: "paid",
    money_mode: "real",
    network: "base",
    amount: "12.50",
    currency: "USDC",
  },
};
const unresolved: PaymentResult = {
  name: "agc_payment_result",
  actor: "buyer_agent",
  source: "gateway",
  refs: { merchant: "m-1", order: "o-1", attempt: "a-1" },
  fields: {
    payment_state: "unresolved",
    money_mode: "test",
    network: "base_sepolia",
    reason_code: "timeout",
  },
};
const outcome: OrderOutcomeChanged = {
  name: "agc_order_outcome_changed",
  actor: "system",
  source: "gateway",
  refs: { merchant: "m-1", order: "o-1" },
  fields: { outcome: "delivered", payment_state: "paid", money_mode: "test" },
};

const SAMPLES: readonly AnalyticsEvent[] = [
  viewed,
  confirmed,
  refusedAtStart,
  created,
  walletSaved,
  imported,
  approved,
  published,
  paused,
  blocked,
  ordered,
  paid,
  unresolved,
  outcome,
];

/** An event as the outbox gives it back: any shape at all. */
type Row = Readonly<{
  name: string;
  actor: string;
  source: string;
  refs: unknown;
  fields: unknown;
}>;

const rowOf = (event: AnalyticsEvent): Row => ({
  name: event.name,
  actor: event.actor,
  source: event.source,
  refs: event.refs ?? {},
  fields: event.fields ?? {},
});

const without = (record: unknown, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record as Record<string, unknown>).filter(([k]) => k !== key));

const problemOf = (row: Row): string | null => {
  const checked = checkedEvent(row);
  return "problem" in checked ? checked.problem : null;
};

describe("the analytics contract a recorded event is held to", () => {
  it("accepts one event of each of the ten kinds as their emitters record them", () => {
    expect(new Set(SAMPLES.map((event) => event.name)).size).toBe(10);
    for (const event of SAMPLES) {
      expect(problemOf(rowOf(event)), event.name).toBeNull();
    }
  });

  it("refuses an event missing any field it requires, naming that field", () => {
    for (const event of SAMPLES) {
      for (const key of Object.keys(event.fields ?? {})) {
        const row = { ...rowOf(event), fields: without(event.fields, key) };
        expect(problemOf(row), `${event.name} without ${key}`).toContain(`properties.${key}`);
      }
    }
  });

  it("refuses an event missing a reference it requires, naming that reference", () => {
    const required: readonly [AnalyticsEvent, string][] = [
      [confirmed, "person"],
      [created, "merchant"],
      [created, "person"],
      [published, "item"],
      [paused, "item"],
      [ordered, "order"],
      [paid, "order"],
      [paid, "attempt"],
      [outcome, "order"],
    ];
    for (const [event, kind] of required) {
      const row = { ...rowOf(event), refs: without(event.refs, kind) };
      expect(problemOf(row), `${event.name} without ${kind}`).toContain(`refs.${kind}`);
    }
  });

  it("refuses a value outside the contract's lists, naming the field", () => {
    const wrong: readonly [AnalyticsEvent, string, unknown][] = [
      [viewed, "screen", "admin"],
      [refusedAtStart, "reason_code", "Invalid email address"],
      [walletSaved, "integration", "shopify"],
      [ordered, "network", "ethereum"],
      [outcome, "outcome", "refunded"],
      [imported, "imported_count", -1],
      [imported, "failed_count", 1.5],
      [confirmed, "first_verification", "yes"],
      [paid, "amount", "12,50"],
      [paid, "amount", 12.5],
    ];
    for (const [event, key, value] of wrong) {
      const row = { ...rowOf(event), fields: { ...event.fields, [key]: value } };
      expect(problemOf(row), `${event.name}.${key} = ${String(value)}`).toContain(
        `properties.${key}`,
      );
    }
    expect(problemOf({ ...rowOf(viewed), actor: "robot" })).toContain("actor_type");
    expect(problemOf({ ...rowOf(viewed), source: "scanner" })).toContain("source");
    expect(problemOf({ ...rowOf(viewed), name: "agc_page_viewed" })).toContain("agc_page_viewed");
  });

  it("refuses a field or a reference the event does not carry, so nothing else rides along", () => {
    expect(
      problemOf({ ...rowOf(viewed), fields: { ...viewed.fields, path: "/dashboard/cards" } }),
    ).toContain("properties.path");
    expect(
      problemOf({ ...rowOf(blocked), fields: { ...blocked.fields, message: "fetch failed" } }),
    ).toContain("properties.message");
    expect(problemOf({ ...rowOf(viewed), refs: { ...viewed.refs, order: "o-1" } })).toContain(
      "refs.order",
    );
    expect(problemOf({ ...rowOf(viewed), refs: { merchant: "" } })).toContain("refs.merchant");
    expect(problemOf({ ...rowOf(viewed), refs: { merchant: 42 } })).toContain("refs.merchant");
    expect(problemOf({ ...rowOf(viewed), refs: "m-1" })).toContain("refs");
    expect(problemOf({ ...rowOf(viewed), fields: null })).toContain("properties");
  });

  it("holds each outcome to the fields that go with it", () => {
    const broken: readonly [string, Row, string][] = [
      [
        "a confirmed sign-in happens only at verification",
        { ...rowOf(confirmed), fields: { ...confirmed.fields, stage: "start" } },
        "properties.stage",
      ],
      [
        "a confirmed sign-in carries no reason",
        { ...rowOf(confirmed), fields: { ...confirmed.fields, reason_code: "unknown" } },
        "properties.reason_code",
      ],
      [
        "a refused sign-in says nothing of a first verification",
        {
          ...rowOf(refusedAtStart),
          fields: { ...refusedAtStart.fields, first_verification: false },
        },
        "properties.first_verification",
      ],
      ["a confirmed sign-in is a person's", { ...rowOf(confirmed), actor: "system" }, "actor_type"],
      ["a merchant is created by a person", { ...rowOf(created), actor: "system" }, "actor_type"],
      [
        "live sales are granted by the operator",
        { ...rowOf(approved), actor: "human" },
        "actor_type",
      ],
      [
        "only an import is partial",
        { ...rowOf(walletSaved), fields: { ...walletSaved.fields, outcome: "partial" } },
        "properties.outcome",
      ],
      [
        "only a payout wallet is pending",
        {
          ...rowOf(approved),
          fields: { ...approved.fields, outcome: "pending" },
        },
        "properties.outcome",
      ],
      [
        "only an import counts products",
        { ...rowOf(walletSaved), fields: { ...walletSaved.fields, imported_count: 0 } },
        "properties.imported_count",
      ],
      [
        "a failed step says why",
        {
          ...rowOf(walletSaved),
          fields: { step: "payout_wallet", outcome: "failed", integration: "none" },
        },
        "properties.reason_code",
      ],
      [
        "a paused merchant names no card",
        {
          ...rowOf(paused),
          fields: { entity: "merchant", change: "paused" },
        },
        "refs.item",
      ],
      [
        "an amount goes with a payment that was paid",
        {
          ...rowOf(unresolved),
          fields: { ...unresolved.fields, amount: "1.00", currency: "USDC" },
        },
        "properties.amount",
      ],
      [
        "an amount comes with its currency",
        { ...rowOf(paid), fields: without(paid.fields, "currency") },
        "properties.currency",
      ],
      [
        "a paid payment has no reason",
        { ...rowOf(paid), fields: { ...paid.fields, reason_code: "unknown" } },
        "properties.reason_code",
      ],
    ];
    for (const [promise, row, field] of broken) {
      expect(problemOf(row), promise).toContain(field);
    }
    // A paid payment whose amount is not known is still a result.
    expect(
      problemOf({ ...rowOf(paid), fields: without(without(paid.fields, "amount"), "currency") }),
    ).toBeNull();
  });
});
