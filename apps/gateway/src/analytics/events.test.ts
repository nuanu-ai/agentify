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
  type PracticeOpened,
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
const platformAnswered: SetupResult = {
  name: "agc_setup_result",
  actor: "human",
  source: "dashboard",
  refs: { merchant: "m-1", person: "p-1" },
  fields: { step: "platform_answer", platform: "code", integration: "none", outcome: "completed" },
};
const connectStarted: SetupResult = {
  name: "agc_setup_result",
  actor: "human",
  source: "dashboard",
  refs: { person: "p-1" },
  fields: { step: "woo_connect", integration: "woocommerce", outcome: "completed" },
};
const preflightRead: SetupResult = {
  name: "agc_setup_result",
  actor: "human",
  source: "dashboard",
  refs: { person: "p-1" },
  fields: {
    step: "woo_preflight",
    integration: "woocommerce",
    outcome: "completed",
    observed_ready_count: 2,
    observed_read_count: 4,
  },
};
const preflightUnread: SetupResult = {
  name: "agc_setup_result",
  actor: "human",
  source: "dashboard",
  refs: { person: "p-1" },
  fields: {
    step: "woo_preflight",
    integration: "woocommerce",
    outcome: "unknown",
    reason_code: "timeout",
  },
};
const shopChecked: SetupResult = {
  name: "agc_setup_result",
  actor: "system",
  source: "woocommerce",
  refs: { merchant: "m-1", person: "p-1" },
  fields: {
    step: "woo_check",
    integration: "woocommerce",
    outcome: "completed",
    observed_ready_count: 2,
    observed_read_count: 4,
  },
};
const checkStopped: SetupResult = {
  name: "agc_setup_result",
  actor: "system",
  source: "woocommerce",
  refs: { merchant: "m-1", person: "p-1" },
  fields: {
    step: "woo_check",
    integration: "woocommerce",
    outcome: "unknown",
    reason_code: "unknown",
    observed_ready_count: 2,
    observed_read_count: 4,
  },
};
const liveRequested: SetupResult = {
  name: "agc_setup_result",
  actor: "human",
  source: "dashboard",
  refs: { merchant: "m-1", person: "p-1" },
  fields: { step: "live_request", integration: "woocommerce", outcome: "completed" },
};
const liveDeclined: SetupResult = {
  name: "agc_setup_result",
  actor: "operator",
  source: "dashboard",
  refs: { merchant: "m-1" },
  fields: { step: "live_decline", integration: "api", outcome: "completed" },
};
const practiceOpened: PracticeOpened = {
  name: "agc_practice_opened",
  actor: "human",
  source: "dashboard",
  refs: { merchant: "m-1", person: "p-1" },
  fields: {},
};
const ONBOARDING: readonly AnalyticsEvent[] = [
  platformAnswered,
  connectStarted,
  preflightRead,
  preflightUnread,
  shopChecked,
  checkStopped,
  liveRequested,
  liveDeclined,
  practiceOpened,
];
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
  ...ONBOARDING,
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
  it("accepts one event of each of the eleven kinds as their emitters record them", () => {
    expect(new Set(SAMPLES.map((event) => event.name)).size).toBe(11);
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
      [platformAnswered, "merchant"],
      [platformAnswered, "person"],
      [connectStarted, "person"],
      [preflightRead, "person"],
      [preflightUnread, "person"],
      [shopChecked, "merchant"],
      [shopChecked, "person"],
      [checkStopped, "merchant"],
      [checkStopped, "person"],
      [liveRequested, "merchant"],
      [liveRequested, "person"],
      [liveDeclined, "merchant"],
      [practiceOpened, "merchant"],
      [practiceOpened, "person"],
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
      problemOf({ ...rowOf(viewed), fields: { ...viewed.fields, path: "/dashboard/products" } }),
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

  it("keeps onboarding actors, sources and private payloads within each fact's contract", () => {
    for (const event of ONBOARDING) {
      expect(
        problemOf({ ...rowOf(event), actor: event.actor === "human" ? "operator" : "human" }),
      ).toContain("actor_type");
      expect(problemOf({ ...rowOf(event), source: "gateway" })).toContain("source");
      expect(
        problemOf({ ...rowOf(event), fields: { ...event.fields, note: "private text" } }),
      ).toContain("properties.note");
      expect(problemOf({ ...rowOf(event), refs: { ...event.refs, order: "o-1" } })).toContain(
        "refs.order",
      );
    }
  });

  it("accepts the platform answer independently of the merchant's actual integration", () => {
    for (const platform of ["woocommerce", "code", "other"]) {
      for (const integration of ["api", "woocommerce", "none"]) {
        expect(
          problemOf({
            ...rowOf(platformAnswered),
            fields: {
              ...platformAnswered.fields,
              platform,
              integration,
            },
          }),
        ).toBeNull();
      }
    }
    for (const platform of ["api", "shopify", "", null]) {
      expect(
        problemOf({
          ...rowOf(platformAnswered),
          fields: {
            ...platformAnswered.fields,
            platform,
          },
        }),
      ).toContain("properties.platform");
    }
    expect(
      problemOf({
        ...rowOf(platformAnswered),
        fields: {
          ...platformAnswered.fields,
          integration: "code",
        },
      }),
    ).toContain("properties.integration");
  });

  it("counts only observations and distinguishes an unread preflight from an observed zero", () => {
    for (const event of [preflightRead, shopChecked, checkStopped]) {
      for (const key of ["observed_ready_count", "observed_read_count"]) {
        for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
          expect(
            problemOf({ ...rowOf(event), fields: { ...event.fields, [key]: value } }),
          ).toContain(`properties.${key}`);
        }
      }
      expect(
        problemOf({
          ...rowOf(event),
          fields: {
            ...event.fields,
            observed_ready_count: 0,
            observed_read_count: 0,
          },
        }),
      ).toBeNull();
      expect(
        problemOf({
          ...rowOf(event),
          fields: {
            ...event.fields,
            observed_ready_count: 5,
            observed_read_count: 4,
          },
        }),
      ).toContain("properties.observed_ready_count");
      expect(
        problemOf({ ...rowOf(event), fields: { ...event.fields, total_count: 500 } }),
      ).toContain("properties.total_count");
    }
    expect(
      problemOf({
        ...rowOf(preflightUnread),
        fields: {
          ...preflightUnread.fields,
          observed_ready_count: 0,
          observed_read_count: 0,
        },
      }),
    ).toContain("properties.observed_ready_count");
    expect(
      problemOf({
        ...rowOf(shopChecked),
        fields: {
          ...shopChecked.fields,
          outcome: "partial",
        },
      }),
    ).toBeNull();
    expect(
      problemOf({
        ...rowOf(preflightRead),
        fields: {
          ...preflightRead.fields,
          outcome: "partial",
        },
      }),
    ).toContain("properties.outcome");
  });

  it("keeps new settled results and decisions within the existing outcome and reason vocabulary", () => {
    for (const event of [platformAnswered, connectStarted, preflightUnread, checkStopped]) {
      for (const outcome of ["blocked", "failed", "unknown"]) {
        expect(
          problemOf({
            ...rowOf(event),
            fields: {
              ...event.fields,
              outcome,
              reason_code: "unknown",
            },
          }),
        ).toBeNull();
      }
      expect(
        problemOf({
          ...rowOf(event),
          fields: {
            ...event.fields,
            outcome: "blocked",
            reason_code: "unsupported_currency",
          },
        }),
      ).toContain("properties.reason_code");
      expect(
        problemOf({
          ...rowOf(event),
          fields: {
            ...without(event.fields, "reason_code"),
            outcome: "failed",
          },
        }),
      ).toContain("properties.reason_code");
    }
    for (const event of [connectStarted, preflightRead, shopChecked]) {
      expect(
        problemOf({ ...rowOf(event), fields: { ...event.fields, integration: "api" } }),
      ).toContain("properties.integration");
    }
    for (const event of [
      platformAnswered,
      connectStarted,
      preflightRead,
      shopChecked,
      liveRequested,
      liveDeclined,
    ]) {
      expect(
        problemOf({ ...rowOf(event), fields: { ...event.fields, reason_code: "unknown" } }),
      ).toContain("properties.reason_code");
    }
    for (const event of [liveRequested, liveDeclined]) {
      for (const outcome of ["blocked", "failed", "unknown", "pending", "declined"]) {
        expect(problemOf({ ...rowOf(event), fields: { ...event.fields, outcome } })).toContain(
          "properties.outcome",
        );
      }
    }
  });

  it("still sends stored legacy facts and connector publication and pause facts", () => {
    expect(problemOf({ ...rowOf(viewed), fields: { screen: "choose_name" } })).toBeNull();
    expect(problemOf({ ...rowOf(imported), actor: "system" })).toBeNull();
    expect(problemOf({ ...rowOf(paused), actor: "system", source: "woocommerce" })).toBeNull();
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
        "a wallet change cannot be partial",
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
        "a wallet change cannot count products",
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
