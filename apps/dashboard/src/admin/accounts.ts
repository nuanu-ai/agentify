/**
 * The workspace's Accounts, one account with its actions, and the Journal.
 *
 * Accounts lists the accounts that made a merchant or hold the operator flag;
 * the rest, mostly people who only opened a scanner's report, are counted and
 * never listed, though an exact address finds one. An account's actions are
 * ending every session, making an operator or removing the flag, and on the
 * test channel forgetting the account. Each goes through `pressed`, so each
 * asks for a fresh sign-in, a ticked consequence and a reason, and each change
 * runs on the journal's transaction with its row.
 *
 * The Journal lists every administrative action newest first, by kind,
 * searched by a merchant's identifier or an account's address, and names
 * accounts by their address where the account still exists.
 */

import type {
  JournalAction,
  JournalPage,
  JournalRow,
  JournalSubject,
} from "@agentify/gateway/journal";
import type { MoneyHistory } from "@agentify/gateway/operator";
import { adminDestinationIn } from "../dashboard-entry.js";
import { type Identity, OperatorMailRefused } from "../identity.js";
import { askedIn, type Listing, listingOf, PAGE_ROWS, type SegmentRule } from "../listing.js";
import type { Outcome } from "../page-services.js";
import { type MomentView, momentView } from "../views.js";
import type { Operator } from "./access.js";
import { type ActionAnswer, type ChangeAnswer, pressed } from "./action.js";
import type { SectionCounts } from "./frame.js";
import type { AdminParts } from "./parts.js";

/** The accounts as an operator reads and changes them. */
export type AccountsDirectory = Pick<
  Identity,
  | "operatorAccounts"
  | "operatorAccount"
  | "byEmail"
  | "endSessionsIn"
  | "setOperatorIn"
  | "forgetIn"
>;

/** What can be done to an account, each its own press. */
const ACCOUNT_ACTS = [
  "end_sessions",
  "grant_operator",
  "remove_operator",
  "forget_account",
] as const;
export type AccountAct = (typeof ACCOUNT_ACTS)[number];

/** A merchant an account names: its seller name, null where none is chosen, or unread. */
export type MerchantNamed = Readonly<{
  id: string;
  name: Readonly<{ chosen: string | null }> | "could-not-be-read";
}>;

export interface AccountRowView {
  readonly id: string;
  readonly email: string;
  /** The operator looking at the page. */
  readonly you: boolean;
  readonly merchant: MerchantNamed | null;
  readonly operator: boolean;
  readonly openSessions: number;
  readonly newestSession: MomentView | null;
}

/** The segments of Accounts, each with the sentence for when it holds none. */
export const ACCOUNTS_SEGMENTS: readonly SegmentRule<AccountRowView>[] = [
  {
    key: "all",
    label: "All",
    holds: () => true,
    none: "No account made a merchant or holds the flag.",
  },
  {
    key: "operators",
    label: "Operators",
    holds: (row) => row.operator,
    none: "No listed account holds the operator flag.",
  },
  {
    key: "merchant",
    label: "With a merchant",
    holds: (row) => row.merchant !== null,
    none: "No listed account made a merchant.",
  },
  {
    key: "no-merchant",
    label: "Without a merchant",
    holds: (row) => row.merchant === null,
    none: "Every listed account made a merchant.",
  },
];

/** How many rows of the journal a page draws. */
const LIST_CUT = PAGE_ROWS;

export interface AccountsListView {
  readonly readAt: MomentView;
  /** The channel is the test channel or a sandbox, where accounts can be forgotten. */
  readonly forgetting: boolean;
  readonly listing: Listing<AccountRowView>;
  /** The accounts that only signed in: counted, never listed. */
  readonly unlisted: number;
}

/** One line of the journal, its people and merchants named where they still exist. */
export interface JournalLineView {
  readonly sequence: number;
  readonly at: MomentView;
  readonly actor:
    | Readonly<{ kind: "account"; id: string; email: string | null }>
    | Readonly<{ kind: "terminal" }>
    | Readonly<{ kind: "configuration" }>;
  readonly action: JournalAction;
  readonly subject: Readonly<{
    kind: JournalSubject["kind"];
    id: string;
    /** The key's merchant; the subject's own identifier otherwise. */
    merchantId: string | null;
    /** An account's address, or a merchant's seller name; null where it no longer resolves or was never chosen. */
    label: string | null;
  }>;
  /** Whether the accounts' addresses were read: where not, an account is named by its identifier, never as deleted. */
  readonly addressesRead: boolean;
  readonly reason: string | null;
  readonly outcome: JournalRow["outcome"];
  /** A refusal said in a sentence, or null. */
  readonly refusal: string | null;
}

type JournalLines =
  | Readonly<{ lines: readonly JournalLineView[]; total: number }>
  | "could-not-be-read";

type ForgetStanding =
  | Readonly<{ kind: "allowed" }>
  | Readonly<{ kind: "live-channel" }>
  | Readonly<{ kind: "operator" }>
  | Readonly<{ kind: "money-history"; history: MoneyHistory }>
  | Readonly<{ kind: "could-not-be-read" }>;

/** What a press on the account page answered, drawn by the form that was pressed. */
export interface AccountPressed {
  readonly act: AccountAct;
  readonly answer: ActionAnswer;
}

export type AccountPageView =
  | Readonly<{
      kind: "found";
      readAt: MomentView;
      account: AccountRowView & Readonly<{ createdAt: MomentView }>;
      /** Whether this account holds the channel's only flag. */
      lastOperator: boolean;
      forget: ForgetStanding;
      history: JournalLines;
      pressed: AccountPressed | null;
    }>
  | Readonly<{ kind: "absent"; id: string; pressed: AccountPressed | null }>;

type JournalKind = "all" | "admission" | "keys" | "sessions" | "flag" | "forgotten";

const JOURNAL_KINDS: Readonly<Record<JournalKind, readonly JournalAction[] | undefined>> = {
  all: undefined,
  admission: ["admit", "withdraw"],
  keys: ["disable_key"],
  sessions: ["end_sessions"],
  flag: ["grant_operator", "remove_operator", "first_operator"],
  forgotten: ["forget_account"],
};

export interface JournalView {
  readonly readAt: MomentView;
  readonly kind: JournalKind;
  /** The kinds the channel can hold, each with its count: null where it failed or the search could not run. */
  readonly kinds: readonly Readonly<{ kind: JournalKind; count: number | null }>[];
  readonly query: string;
  /** How the search was read: a merchant's identifier, an account's address, or an account's identifier. */
  readonly searchedAs: "merchant" | "address" | "identifier" | null;
  /** Why a search found nothing to search by, or null. */
  readonly unsearched: "no-such-account" | "not-searchable" | null;
  readonly lines: readonly JournalLineView[];
  readonly total: number;
  /** Where the page of older rows starts, or null where these are the oldest. */
  readonly before: number | null;
  readonly next: number | null;
}

/** The sentences a refusal's code is said in, where the journal shows it. */
const REFUSALS: Readonly<Record<string, string>> = {
  sign_in_not_fresh: "the sign-in was older than fifteen minutes; nothing changed",
  not_confirmed: "the consequence was not ticked; nothing changed",
  no_reason: "no reason was written; nothing changed",
  reason_refused: "the reason could not be kept as written; nothing changed",
  no_such_account: "no account has that identifier; nothing changed",
  last_operator: "it is the channel's last operator; nothing changed",
  holds_flag: "the account holds the operator flag; remove the flag first; nothing changed",
  mail_not_handed:
    "a mail to an operator was not handed to the provider; the flag stayed as it was",
  live_channel: "accounts are forgotten only on the test channel; nothing changed",
  money_history: "the merchant has orders or receipts, which are never deleted; nothing changed",
  shared_merchant: "another account names the same merchant; nothing changed",
  history_unread: "whether the merchant has orders or receipts could not be read; nothing changed",
  not_live_channel: "admission is decided on the live channel only; nothing changed",
  no_such_merchant: "no merchant has that identifier; nothing changed",
  no_such_key: "the key is not one of this merchant's; nothing changed",
};

export const refusalSaid = (code: string): string =>
  REFUSALS[code] ?? `refused with the code ${code}; nothing changed`;

export interface AccountsPages {
  list(operator: Operator, query: URLSearchParams): Promise<Outcome<AccountsListView>>;
  one(
    operator: Operator,
    accountId: string,
    pressed: AccountPressed | null,
  ): Promise<Outcome<AccountPageView>>;
  press(
    operator: Operator,
    accountId: string,
    act: AccountAct,
    form: FormData,
  ): Promise<Outcome<AccountPressed>>;
  journal(operator: Operator, query: URLSearchParams): Promise<Outcome<JournalView>>;
  /** The Accounts and Journal sections' counts in the sidebar: nothing waits there. */
  counts(operator: Operator): Promise<SectionCounts>;
}

const momentOf = (at: Date | number): MomentView => momentView(new Date(at).toISOString());

const oneParam = (query: URLSearchParams, name: string): string => {
  const values = query.getAll(name);
  return values.length === 1 ? (values[0] ?? "") : "";
};

/** Seller names of the merchants among `ids`; "could-not-be-read" for each where the read failed. */
async function merchantsNamedIn(reader: AdminParts["reader"], ids: readonly string[]) {
  try {
    const named = await reader.accounts.merchantsNamed(ids);
    return (id: string): MerchantNamed => ({
      id,
      name: { chosen: named.find((one) => one.id === id)?.serviceName ?? null },
    });
  } catch {
    console.error("[dashboard] the merchants' names for the workspace could not be read");
    return (id: string): MerchantNamed => ({ id, name: "could-not-be-read" });
  }
}

/**
 * The journal's rows as the Journal draws them, its accounts and merchants
 * named where they still exist. A failed read of the names never fails the
 * lines: each names its records by identifier instead.
 */
export async function journalLinesOf(
  parts: Pick<AdminParts, "identity" | "reader">,
  rows: readonly JournalRow[],
): Promise<JournalLineView[]> {
  const accountIds = new Set<string>();
  const merchantIds = new Set<string>();
  for (const row of rows) {
    if (row.actor.kind === "account") accountIds.add(row.actor.id);
    if (row.subject.kind === "account") accountIds.add(row.subject.id);
    if (row.subject.kind === "merchant") merchantIds.add(row.subject.id);
    if (row.subject.kind === "key") merchantIds.add(row.subject.merchantId);
  }
  const emails = await parts.identity
    .accountsNamed({ accountIds: [...accountIds] })
    .then((named) => new Map(named.map((one) => [one.id, one.email])))
    .catch(() => {
      console.error("[dashboard] the accounts' addresses for the journal could not be read");
      return null;
    });
  const named = await merchantsNamedIn(parts.reader, [...merchantIds]);
  const merchantLabel = (id: string): string | null => {
    const name = named(id).name;
    return name === "could-not-be-read" ? null : name.chosen;
  };
  const emailOf = (id: string): string | null => emails?.get(id) ?? null;
  return rows.map((row) => ({
    sequence: row.sequence,
    at: momentOf(row.at),
    actor:
      row.actor.kind === "account"
        ? { kind: "account", id: row.actor.id, email: emailOf(row.actor.id) }
        : row.actor,
    action: row.action,
    subject: {
      kind: row.subject.kind,
      id: row.subject.id,
      merchantId:
        row.subject.kind === "key"
          ? row.subject.merchantId
          : row.subject.kind === "merchant"
            ? row.subject.id
            : null,
      label:
        row.subject.kind === "account"
          ? emailOf(row.subject.id)
          : merchantLabel(row.subject.kind === "key" ? row.subject.merchantId : row.subject.id),
    },
    addressesRead: emails !== null,
    reason: row.reason,
    outcome: row.outcome,
    refusal: row.outcome.kind === "refused" ? refusalSaid(row.outcome.code) : null,
  }));
}

export function accountsFor(parts: AdminParts): AccountsPages {
  const { accounts, reader, journal } = parts;
  const store = parts.gateway.runtime.store;
  const forgettingHere = parts.config.surfaceMode !== "live";

  const namesOf = (ids: readonly string[]) => merchantsNamedIn(reader, ids);

  const rowOf = (
    operator: Operator,
    named: (id: string) => MerchantNamed,
    summary: Awaited<ReturnType<AccountsDirectory["operatorAccounts"]>>["listed"][number],
  ): AccountRowView => ({
    id: summary.id,
    email: summary.email,
    you: summary.id === operator.person.id,
    merchant: summary.merchantId === null ? null : named(summary.merchantId),
    operator: summary.operator,
    openSessions: summary.openSessions,
    newestSession: summary.newestSession === null ? null : momentOf(summary.newestSession),
  });

  const linesOf = (rows: readonly JournalRow[]) => journalLinesOf(parts, rows);

  const historyOfAccount = async (accountId: string): Promise<JournalLines> => {
    try {
      const page = await store.journal({ about: { account: accountId }, limit: LIST_CUT });
      return { lines: await linesOf(page.rows), total: page.total };
    } catch {
      console.error("[dashboard] an account's journal could not be read");
      return "could-not-be-read";
    }
  };

  const forgetStanding = async (
    merchantId: string | null,
    holdsFlag: boolean,
  ): Promise<ForgetStanding> => {
    if (!forgettingHere) return { kind: "live-channel" };
    if (holdsFlag) return { kind: "operator" };
    if (merchantId === null) return { kind: "allowed" };
    try {
      const history = await reader.accounts.historyOf(merchantId);
      return history.orders > 0 || history.receipts > 0
        ? { kind: "money-history", history }
        : { kind: "allowed" };
    } catch {
      console.error("[dashboard] a merchant's money history could not be read");
      return { kind: "could-not-be-read" };
    }
  };

  /** Each act's change on the journal's transaction, answered as the journal settles it. */
  const changeOf = (
    operator: Operator,
    accountId: string,
    act: AccountAct,
  ): Parameters<typeof pressed>[2] => {
    const at = parts.now();
    const refused = (code: string): ChangeAnswer => ({
      kind: "refused",
      code,
      said: `${refusalSaid(code).slice(0, 1).toUpperCase()}${refusalSaid(code).slice(1)}.`,
    });
    const settled = (changed: boolean | null): ChangeAnswer =>
      changed === null ? refused("no_such_account") : { kind: changed ? "done" : "unchanged" };
    switch (act) {
      case "end_sessions":
        return async (press) => {
          const ended = await journal.along(press, async (tx) => {
            const result = await accounts.endSessionsIn(tx, accountId, at);
            return { result, changed: result === "no-account" ? null : result === "ended" };
          });
          return settled(ended === "no-account" ? null : ended === "ended");
        };
      case "grant_operator":
      case "remove_operator":
        return async (press) => {
          const on = act === "grant_operator";
          try {
            const flagged = await journal.along(press, async (tx) => {
              const result = await accounts.setOperatorIn(tx, accountId, on, {
                at,
                by: operator.person.email,
              });
              return {
                result,
                changed: result === "changed" ? true : result === "unchanged" ? false : null,
              };
            });
            if (flagged === "last-operator") return refused("last_operator");
            return settled(flagged === "changed" ? true : flagged === "unchanged" ? false : null);
          } catch (thrown) {
            if (thrown instanceof OperatorMailRefused) return refused("mail_not_handed");
            throw thrown;
          }
        };
      case "forget_account":
        return async (press) => {
          if (!forgettingHere) return refused("live_channel");
          // Asked through the gateway's reads too, since in memory the
          // merchant's orders are the gateway's alone; on Postgres the change
          // asks again under its lock. A read that fails refuses the press,
          // which has changed nothing yet.
          const history = await accounts
            .operatorAccount(accountId, at)
            .then((account) =>
              account?.merchantId === null || account?.merchantId === undefined
                ? { orders: 0, receipts: 0 }
                : reader.accounts.historyOf(account.merchantId),
            )
            .catch(() => null);
          if (history === null) return refused("history_unread");
          if (history.orders > 0 || history.receipts > 0) return refused("money_history");
          const forgotten = await journal.along(press, async (tx) => {
            const result = await accounts.forgetIn(tx, accountId);
            return { result, changed: result.kind === "forgotten" ? true : null };
          });
          switch (forgotten.kind) {
            case "forgotten":
              return { kind: "done" };
            case "no-account":
              return refused("no_such_account");
            case "operator":
              return refused("holds_flag");
            case "money-history":
              return refused("money_history");
            case "shared-merchant":
              return refused("shared_merchant");
          }
        };
    }
  };

  return {
    async list(operator, query) {
      const now = parts.now();
      const listing = await accounts.operatorAccounts(now);
      const asked = askedIn(
        query,
        ACCOUNTS_SEGMENTS.map((one) => one.key),
      );
      const summaries = [...listing.listed];
      if (asked.q.includes("@")) {
        // An exact address finds an account that only signed in, which is
        // never listed: the operator already holds the address.
        const exact = await accounts.byEmail(asked.q);
        if (exact !== null && !summaries.some((one) => one.id === exact.id)) {
          const found = await accounts.operatorAccount(exact.id, now);
          if (found !== null) summaries.push(found);
        }
      }
      summaries.sort(
        (one, other) =>
          (other.newestSession?.getTime() ?? 0) - (one.newestSession?.getTime() ?? 0) ||
          one.email.localeCompare(other.email),
      );
      const named = await namesOf(
        summaries.flatMap((one) => (one.merchantId === null ? [] : [one.merchantId])),
      );
      return {
        kind: "view",
        view: {
          readAt: momentOf(now),
          forgetting: forgettingHere,
          listing: listingOf({
            rows: summaries.map((one) => rowOf(operator, named, one)),
            asked,
            path: "/admin/accounts",
            segments: ACCOUNTS_SEGMENTS,
            matches: (row, words) =>
              row.email.includes(words) ||
              (row.merchant !== null &&
                (row.merchant.id.toLowerCase().includes(words) ||
                  (row.merchant.name !== "could-not-be-read" &&
                    (row.merchant.name.chosen ?? "").toLowerCase().includes(words)))),
            noMatch: (q, within) =>
              `No listed account${within === null ? "" : ` among ${within.toLowerCase()}`} matches “${q}”. An address that only signed in is found by the whole address.`,
            showAll: "Show all accounts",
          }),
          unlisted: listing.unlisted,
        },
      };
    },

    async one(operator, accountId, pressedNow) {
      const now = parts.now();
      const found = await accounts.operatorAccount(accountId, now);
      if (found === null) {
        return {
          kind: "view",
          status: pressedNow === null ? 404 : 200,
          view: { kind: "absent", id: accountId, pressed: pressedNow },
        };
      }
      const operators = (await accounts.operatorAccounts(now)).listed.filter((one) => one.operator);
      const lastOperator = found.operator && operators.length === 1;
      const named = await namesOf(found.merchantId === null ? [] : [found.merchantId]);
      return {
        kind: "view",
        view: {
          kind: "found",
          readAt: momentOf(now),
          account: { ...rowOf(operator, named, found), createdAt: momentOf(found.createdAt) },
          lastOperator,
          forget: await forgetStanding(found.merchantId, found.operator),
          history: await historyOfAccount(found.id),
          pressed: pressedNow,
        },
      };
    },

    async press(operator, accountId, act, form) {
      const destination = adminDestinationIn(`admin/accounts/${accountId}`);
      if (destination === null) {
        return { kind: "problem", problem: { status: 404, said: "There is no such page." } };
      }
      const answer = await pressed(
        {
          operator,
          form,
          action: act,
          subject: { kind: "account", id: accountId },
          needsReason: true,
          destination,
        },
        parts.pressing,
        changeOf(operator, accountId, act),
      );
      return { kind: "view", view: { act, answer } };
    },

    async journal(_operator, query) {
      const now = parts.now();
      const wanted = oneParam(query, "kind");
      const kinds = (Object.keys(JOURNAL_KINDS) as JournalKind[]).filter(
        (kind) => forgettingHere || kind !== "forgotten",
      );
      const kind = kinds.find((one) => one === wanted) ?? "all";
      const asked = oneParam(query, "q").trim();
      const beforeText = oneParam(query, "before");
      const before = /^[1-9][0-9]{0,15}$/.test(beforeText) ? Number(beforeText) : null;

      let about: { merchant: string } | { account: string } | undefined;
      let unsearched: JournalView["unsearched"] = null;
      let searchedAs: JournalView["searchedAs"] = null;
      if (asked !== "") {
        if (/^mch_[A-Za-z0-9_-]{1,64}$/.test(asked)) {
          about = { merchant: asked };
          searchedAs = "merchant";
        } else if (asked.includes("@")) {
          const person = await accounts.byEmail(asked);
          if (person === null) unsearched = "no-such-account";
          else {
            about = { account: person.id };
            searchedAs = "address";
          }
        } else if (/^[A-Za-z0-9_-]{1,64}$/.test(asked)) {
          searchedAs = "identifier";
          // Not asked whether the account still exists: a forgotten one's rows
          // keep its identifier.
          about = { account: asked };
        } else unsearched = "not-searchable";
      }

      // Each kind's count is read on its own; one that fails is drawn as
      // unread rather than as none.
      const counted = await Promise.all(
        kinds.map(async (one) => {
          // A search that could not run counts nothing.
          if (unsearched !== null) return { kind: one, count: null };
          try {
            const actions = JOURNAL_KINDS[one];
            const page = await store.journal({
              ...(about === undefined ? {} : { about }),
              ...(actions === undefined ? {} : { actions }),
              limit: 1,
            });
            return { kind: one, count: page.total };
          } catch {
            return { kind: one, count: null };
          }
        }),
      );
      const actions = JOURNAL_KINDS[kind];
      const page: JournalPage =
        unsearched !== null
          ? { rows: [], total: 0, next: null }
          : await store.journal({
              ...(about === undefined ? {} : { about }),
              ...(actions === undefined ? {} : { actions }),
              ...(before === null ? {} : { before }),
              limit: LIST_CUT,
            });
      return {
        kind: "view",
        view: {
          readAt: momentOf(now),
          kind,
          kinds: counted,
          query: asked,
          searchedAs,
          unsearched,
          lines: await linesOf(page.rows),
          total: page.total,
          before,
          next: page.next,
        },
      };
    },

    counts: async () => ({}),
  };
}
