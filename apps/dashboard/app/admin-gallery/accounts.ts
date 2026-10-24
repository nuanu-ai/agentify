/**
 * The accounts area's gallery states: Accounts, one account with each of its
 * actions answered every way a press can be, and the Journal. The data is
 * made up, built with the views' own functions: no real person or merchant.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS, type SurfaceMode } from "@agentify/core";
import { UNSAFE_ErrorResponseImpl as ErrorResponseImpl } from "react-router";
import {
  ACCOUNTS_SEGMENTS,
  type AccountPageView,
  type AccountPressed,
  type AccountRowView,
  type AccountsListView,
  type JournalLineView,
  type JournalView,
  refusalSaid,
} from "../../src/admin/accounts.js";
import type { ActionAnswer } from "../../src/admin/action.js";
import { askedIn, listingOf } from "../../src/listing.js";
import { momentView } from "../../src/views.js";
import type { Trouble } from "../answer.js";
import type { AdminGalleryState } from "./state.js";

const READ_AT = momentView("2026-10-24T14:10:00Z");
const ME = "Xq9fT2mLwP4kR7sV1bN8Yc3dE6gH0jK2";
const COLLEAGUE = "Lm4nB7vC2xZ9qW1eR5tY8uI3oP6aS0dF";
const SELLER = "Gh2jK5lM8nB1vC4xZ7qW0eR3tY6uI9oP";
const QUIET = "Ty7uI0oP3aS6dF9gH2jK5lM8nB1vC4xZ";
const SELLER_MERCHANT = "mch_78f0c3eaf1edb0c9086a6d2ae1731c28";
const QUIET_MERCHANT = "mch_2c41d9a07be35f8e1a6c0d4b9e72f513";

const row = (fields: Partial<AccountRowView> & Pick<AccountRowView, "id" | "email">) =>
  ({
    you: false,
    merchant: null,
    operator: false,
    openSessions: 0,
    newestSession: null,
    ...fields,
  }) satisfies AccountRowView;

const ROWS: readonly AccountRowView[] = [
  row({
    id: ME,
    email: "operator@example.com",
    you: true,
    operator: true,
    openSessions: 2,
    newestSession: momentView("2026-10-24T11:58:00Z"),
  }),
  row({
    id: SELLER,
    email: "owner@shop.example",
    merchant: { id: SELLER_MERCHANT, name: { chosen: "Example Rooms" } },
    // Signed in again after every session was ended at 09:30.
    openSessions: 1,
    newestSession: momentView("2026-10-24T11:40:00Z"),
  }),
  row({
    id: COLLEAGUE,
    email: "ops@example.com",
    operator: true,
    openSessions: 1,
    newestSession: momentView("2026-10-20T16:02:00Z"),
  }),
  row({
    id: QUIET,
    email: "hello@elsewhere.example",
    merchant: { id: QUIET_MERCHANT, name: { chosen: null } },
  }),
];

const listOf = (
  rows: readonly AccountRowView[],
  query: string,
  forgetting: boolean,
): AccountsListView => ({
  readAt: READ_AT,
  forgetting,
  listing: listingOf({
    rows,
    asked: askedIn(
      new URLSearchParams(query),
      ACCOUNTS_SEGMENTS.map((one) => one.key),
    ),
    path: "/admin/accounts",
    segments: ACCOUNTS_SEGMENTS,
    matches: (one, words) => one.email.includes(words),
    noMatch: (q) =>
      `No listed account matches “${q}”. An address that only signed in is found by the whole address.`,
    showAll: "Show all accounts",
  }),
  unlisted: 16,
});

/** A journal line as the Journal and the Overview draw it, its accounts' addresses read. */
export const line = (
  sequence: number,
  at: string,
  fields: Omit<JournalLineView, "sequence" | "at" | "refusal" | "addressesRead">,
): JournalLineView => ({
  sequence,
  at: momentView(at),
  refusal: fields.outcome.kind === "refused" ? refusalSaid(fields.outcome.code) : null,
  addressesRead: true,
  ...fields,
});

const byMe = { kind: "account", id: ME, email: "operator@example.com" } as const;

const LINES: readonly JournalLineView[] = [
  line(7, "2026-10-24T09:30:00Z", {
    actor: byMe,
    action: "end_sessions",
    subject: { kind: "account", id: SELLER, merchantId: null, label: "owner@shop.example" },
    reason: "Sign-in links were asked for from many networks within an hour",
    outcome: { kind: "done" },
  }),
  line(6, "2026-10-23T17:05:00Z", {
    actor: byMe,
    action: "remove_operator",
    subject: { kind: "account", id: ME, merchantId: null, label: "operator@example.com" },
    reason: "Checking the rule",
    outcome: { kind: "refused", code: "last_operator" },
  }),
  line(5, "2026-10-22T10:12:00Z", {
    actor: byMe,
    action: "grant_operator",
    subject: { kind: "account", id: COLLEAGUE, merchantId: null, label: "ops@example.com" },
    reason: "Joins the team that looks after the channel",
    outcome: { kind: "done" },
  }),
  line(4, "2026-10-21T16:21:00Z", {
    actor: { kind: "account", id: COLLEAGUE, email: "ops@example.com" },
    action: "disable_key",
    subject: { kind: "key", id: "mk_5f1c", merchantId: SELLER_MERCHANT, label: "Example Rooms" },
    reason: "The merchant reported the key shared outside their team",
    outcome: { kind: "done" },
  }),
  line(3, "2026-10-14T10:02:00Z", {
    actor: byMe,
    action: "disable_key",
    subject: { kind: "key", id: "mk_2a9e", merchantId: SELLER_MERCHANT, label: "Example Rooms" },
    reason: "A key the merchant no longer uses was still working",
    outcome: { kind: "done" },
  }),
  line(2, "2026-10-13T12:40:00Z", {
    actor: byMe,
    action: "forget_account",
    subject: {
      kind: "account",
      id: "Pq8wE5rT2yU9iO6pA3sD0fG7hJ4kL1zX",
      merchantId: null,
      label: null,
    },
    reason: "A test address asked to start over",
    outcome: { kind: "done" },
  }),
  line(1, "2026-10-12T08:47:00Z", {
    actor: { kind: "configuration" },
    action: "first_operator",
    subject: { kind: "account", id: ME, merchantId: null, label: "operator@example.com" },
    reason: null,
    outcome: { kind: "done" },
  }),
];

const journalOf = (fields: Partial<JournalView>): JournalView => ({
  readAt: READ_AT,
  kind: "all",
  kinds: [
    { kind: "all", count: LINES.length },
    { kind: "admission", count: 0 },
    { kind: "keys", count: 2 },
    { kind: "sessions", count: 1 },
    { kind: "flag", count: 3 },
    { kind: "forgotten", count: 1 },
  ],
  query: "",
  searchedAs: null,
  unsearched: null,
  lines: LINES,
  total: LINES.length,
  before: null,
  next: null,
  ...fields,
});

const SELLER_PAGE: Extract<AccountPageView, { kind: "found" }> = {
  kind: "found",
  readAt: READ_AT,
  account: { ...(ROWS[1] as AccountRowView), createdAt: momentView("2026-09-02T09:14:00Z") },
  lastOperator: false,
  forget: { kind: "live-channel" },
  history: { lines: LINES.filter((one) => one.subject.id === SELLER), total: 1 },
  pressed: null,
};

const MY_PAGE: Extract<AccountPageView, { kind: "found" }> = {
  ...SELLER_PAGE,
  account: { ...(ROWS[0] as AccountRowView), createdAt: momentView("2026-09-12T08:40:00Z") },
  lastOperator: true,
  forget: { kind: "operator" },
  history: { lines: LINES.filter((one) => one.subject.id === ME), total: 2 },
};

const COLLEAGUE_PAGE: Extract<AccountPageView, { kind: "found" }> = {
  ...SELLER_PAGE,
  account: { ...(ROWS[2] as AccountRowView), createdAt: momentView("2026-10-02T09:15:00Z") },
  history: { lines: LINES.filter((one) => one.subject.id === COLLEAGUE), total: 1 },
};

const pressedAs = (act: AccountPressed["act"], answer: ActionAnswer): AccountPressed => ({
  act,
  answer,
});

const STEP_UP: ActionAnswer = {
  kind: "step-up",
  stepUp: {
    email: "operator@example.com",
    signedInAt: momentView("2026-10-24T12:05:00Z"),
    destination: `admin/accounts/${SELLER}`,
    googleEnabled: true,
    link: null,
  },
};

const chromeIn = (mode: SurfaceMode) => ({
  base: "",
  surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode, words: SURFACE_WORDS[mode] },
});

const account = (
  told: Pick<AdminGalleryState, "id" | "when" | "cause">,
  view: AccountPageView,
  options: Readonly<{ mode?: SurfaceMode; press?: string }> = {},
): AdminGalleryState => {
  const id = view.kind === "found" ? view.account.id : view.id;
  return {
    ...told,
    screen: "Account",
    path: `/admin/accounts/${id}${options.press === undefined ? "" : `/${options.press}`}`,
    mode: options.mode ?? "live",
    loaded: {
      "routes/admin/account": view,
      ...(options.press === undefined ? {} : { [`routes/admin/account-${options.press}`]: null }),
    },
  };
};

export const ACCOUNTS_STATES: readonly AdminGalleryState[] = [
  {
    id: "dashboard-admin-accounts",
    screen: "Accounts",
    when: "An operator opens Accounts on the live channel.",
    cause:
      "The accounts that made a merchant or hold the flag are listed, newest session first; the ones that only signed in are counted.",
    path: "/admin/accounts",
    mode: "live",
    loaded: { "routes/admin/accounts": listOf(ROWS, "", false) },
  },
  {
    id: "dashboard-admin-accounts-test",
    screen: "Accounts",
    when: "An operator opens the operators among the accounts on the test channel.",
    cause: "The segment is a link, so the filtered list has an address of its own.",
    path: "/admin/accounts?show=operators",
    mode: "test",
    loaded: { "routes/admin/accounts": listOf(ROWS, "show=operators", true) },
  },
  {
    id: "dashboard-admin-accounts-no-match",
    screen: "Accounts",
    when: "An operator searches Accounts for words no listed account holds.",
    cause: "Nothing listed matches; an account that only signed in is found by its whole address.",
    path: "/admin/accounts?q=nobody",
    mode: "live",
    loaded: { "routes/admin/accounts": listOf(ROWS, "q=nobody", false) },
  },
  {
    id: "dashboard-admin-accounts-names-unread",
    screen: "Accounts",
    when: "An operator opens Accounts while the merchants' seller names cannot be read.",
    cause:
      "The read of the names across merchants failed, so each merchant is named by its identifier and the name is said to be unread.",
    path: "/admin/accounts",
    mode: "live",
    loaded: {
      "routes/admin/accounts": listOf(
        ROWS.map((one) =>
          one.merchant === null
            ? one
            : { ...one, merchant: { id: one.merchant.id, name: "could-not-be-read" as const } },
        ),
        "",
        false,
      ),
    },
  },
  {
    id: "dashboard-admin-accounts-unread",
    screen: "Accounts",
    when: "An operator opens Accounts while the accounts cannot be read.",
    cause: "The read of the accounts failed, so the page says so and offers itself again.",
    path: "/admin/accounts",
    mode: "live",
    failed: {
      "routes/gate": new ErrorResponseImpl(500, "", {
        kind: "unread",
        chrome: chromeIn("live"),
        again: "/admin/accounts",
      } satisfies Trouble),
    },
  },
  account(
    {
      id: "dashboard-admin-account",
      when: "An operator opens a merchant's account on the live channel.",
      cause: "The account holds no flag, so it offers Make an operator beside End every session.",
    },
    SELLER_PAGE,
  ),
  account(
    {
      id: "dashboard-admin-account-last-operator",
      when: "The channel's only operator opens their own account on the test channel.",
      cause:
        "The last operator's flag cannot be removed nor their account forgotten, so neither is offered.",
    },
    MY_PAGE,
    { mode: "test" },
  ),
  account(
    {
      id: "dashboard-admin-account-forget",
      when: "An operator opens a merchant's account on the test channel, the merchant with no order.",
      cause: "On the test channel an account whose merchant has no money history can be forgotten.",
    },
    { ...SELLER_PAGE, forget: { kind: "allowed" } },
    { mode: "test" },
  ),
  account(
    {
      id: "dashboard-admin-account-money-history",
      when: "An operator opens a merchant's account on the test channel, the merchant with orders.",
      cause: "Orders and receipts are never deleted, so the account is not offered for forgetting.",
    },
    { ...SELLER_PAGE, forget: { kind: "money-history", history: { orders: 3, receipts: 2 } } },
    { mode: "test" },
  ),
  account(
    {
      id: "dashboard-admin-account-unread",
      when: "An operator opens an account while the journal and the merchant's orders cannot be read.",
      cause:
        "Both reads failed: the history is said to be unread, and forgetting waits until the orders are read.",
    },
    { ...SELLER_PAGE, history: "could-not-be-read", forget: { kind: "could-not-be-read" } },
    { mode: "test" },
  ),
  account(
    {
      id: "dashboard-admin-account-history-names-unread",
      when: "An operator opens an account while the addresses of the accounts in its history cannot be read.",
      cause:
        "The journal was read but the identity did not answer for the accounts it names, so each is named by its identifier rather than as deleted.",
    },
    {
      ...SELLER_PAGE,
      history: {
        lines: LINES.filter((one) => one.subject.id === SELLER).map((one) => ({
          ...one,
          addressesRead: false,
          actor: one.actor.kind === "account" ? { ...one.actor, email: null } : one.actor,
          subject: one.subject.kind === "account" ? { ...one.subject, label: null } : one.subject,
        })),
        total: 1,
      },
    },
  ),
  account(
    {
      id: "dashboard-admin-account-absent",
      when: "An operator opens an account identifier no account on the channel holds.",
      cause: "The account was forgotten or erased, or the identifier was mistyped.",
    },
    { kind: "absent", id: "Zz9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gF", pressed: null },
  ),
  account(
    {
      id: "dashboard-admin-account-sessions-ended",
      when: "An operator ended every session of an account with a fresh sign-in and a reason.",
      cause:
        "The sessions were deleted with the journal's row in one transaction; the history shows it.",
    },
    {
      ...SELLER_PAGE,
      account: { ...SELLER_PAGE.account, openSessions: 0, newestSession: null },
      history: {
        lines: [
          line(8, "2026-10-24T14:09:00Z", {
            actor: byMe,
            action: "end_sessions",
            subject: { kind: "account", id: SELLER, merchantId: null, label: "owner@shop.example" },
            reason: "The owner asked to be signed out on every device",
            outcome: { kind: "done" },
          }),
          ...LINES.filter((one) => one.subject.id === SELLER),
        ],
        total: 2,
      },
      pressed: pressedAs("end_sessions", { kind: "done" }),
    },
    { press: "end-sessions" },
  ),
  account(
    {
      id: "dashboard-admin-account-sessions-unknown",
      when: "An operator ends every session of an account and the answer is lost on the way.",
      cause: "The change may or may not have committed, so the outcome is said to be unknown.",
    },
    { ...SELLER_PAGE, pressed: pressedAs("end_sessions", { kind: "unknown" }) },
    { press: "end-sessions" },
  ),
  account(
    {
      id: "dashboard-admin-account-step-up",
      when: "An operator whose sign-in is older than fifteen minutes presses Make an operator.",
      cause:
        "Every action asks for a fresh sign-in; nothing was changed, and nothing happens by itself after the sign-in.",
    },
    { ...SELLER_PAGE, pressed: pressedAs("grant_operator", STEP_UP) },
    { press: "grant-operator" },
  ),
  account(
    {
      id: "dashboard-admin-account-no-reason",
      when: "An operator presses Make an operator without writing a reason.",
      cause: "Every intervention asks for a reason; the refusal is written to the journal.",
    },
    {
      ...SELLER_PAGE,
      pressed: pressedAs("grant_operator", {
        kind: "refused",
        said: "Write the reason; it is kept in the journal. Nothing was changed.",
      }),
    },
    { press: "grant-operator" },
  ),
  account(
    {
      id: "dashboard-admin-account-mail-refused",
      when: "An operator removes another operator's flag while the mail provider refuses the mail.",
      cause: "The flag changes only once every operator was mailed, so it stayed as it was.",
    },
    {
      ...COLLEAGUE_PAGE,
      pressed: pressedAs("remove_operator", {
        kind: "refused",
        said: `${refusalSaid("mail_not_handed").slice(0, 1).toUpperCase()}${refusalSaid("mail_not_handed").slice(1)}.`,
      }),
    },
    { press: "remove-operator" },
  ),
  account(
    {
      id: "dashboard-admin-account-forgotten",
      when: "An operator forgot an account on the test channel.",
      cause:
        "The account and its merchant were removed with the journal's row; the page now finds no such account.",
    },
    { kind: "absent", id: SELLER, pressed: pressedAs("forget_account", { kind: "done" }) },
    { mode: "test", press: "forget" },
  ),
  {
    id: "dashboard-admin-journal",
    screen: "Journal",
    when: "An operator opens the Journal on the test channel.",
    cause:
      "Every administrative action and refused press, newest first, with who acted, the reason and where it came from.",
    path: "/admin/journal",
    mode: "test",
    loaded: { "routes/admin/journal": journalOf({}) },
  },
  {
    id: "dashboard-admin-journal-kind",
    screen: "Journal",
    when: "An operator narrows the Journal on the live channel to the operator flag.",
    cause:
      "A kind is a link; the live channel forgets no account, so it offers no such kind, and one count could not be read.",
    path: "/admin/journal?kind=flag",
    mode: "live",
    loaded: {
      "routes/admin/journal": journalOf({
        kind: "flag",
        kinds: [
          { kind: "all", count: LINES.filter((one) => one.action !== "forget_account").length },
          { kind: "admission", count: null },
          { kind: "keys", count: 2 },
          { kind: "sessions", count: 1 },
          { kind: "flag", count: 3 },
        ],
        lines: LINES.filter((one) =>
          ["grant_operator", "remove_operator", "first_operator"].includes(one.action),
        ),
        total: 3,
      }),
    },
  },
  {
    id: "dashboard-admin-journal-unsearched",
    screen: "Journal",
    when: "An operator searches the Journal for words that name no merchant or account.",
    cause:
      "The journal is searched by a merchant's identifier or an account's address or identifier.",
    path: "/admin/journal?q=lost+laptop",
    mode: "live",
    loaded: {
      "routes/admin/journal": journalOf({
        query: "lost laptop",
        unsearched: "not-searchable",
        kinds: journalOf({}).kinds.map((one) => ({ ...one, count: null })),
        lines: [],
        total: 0,
      }),
    },
  },
  {
    id: "dashboard-admin-journal-empty",
    screen: "Journal",
    when: "An operator opens the Journal of a channel where nothing was done yet.",
    cause: "No administrative action has been pressed on this channel.",
    path: "/admin/journal",
    mode: "test",
    loaded: {
      "routes/admin/journal": journalOf({
        kinds: journalOf({}).kinds.map((one) => ({ ...one, count: 0 })),
        lines: [],
        total: 0,
      }),
    },
  },
];
