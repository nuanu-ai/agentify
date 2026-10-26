/**
 * The workspace's Merchants list and one merchant's page, and every action on
 * a merchant: admit to live sales, withdraw the admission with the note the
 * merchant reads, and disable a key. The figures come from the operator's
 * reader, the account behind a merchant and a shop's facts from the
 * dashboard's own records, and the history from the journal; every action
 * goes through the workspace's one press, which asks for a fresh sign-in, the
 * ticked box and the reason, and journals every refusal. The page never
 * changes a merchant's name, wallet or cards, and no order.
 */

import type { SurfaceMode } from "@agentify/core";
import { grantLiveApproval, withdrawLiveApproval } from "@agentify/gateway";
import type { JournalPress, JournalRow } from "@agentify/gateway/journal";
import {
  askedOn,
  MERCHANT_SEGMENTS,
  type MerchantList,
  type MerchantRecord,
  type MerchantRow,
  type MerchantSegment,
} from "@agentify/gateway/operator";
import type { NamedAccount } from "../dashboard-entry.js";

/** The reader's facts the views are drawn from, for the code that draws them without the reader. */
export type { MerchantList, MerchantRecord, MerchantRow } from "@agentify/gateway/operator";

import type { SectionCounts } from "@agentify/ui/workspace-view";
import { askedIn, type Listing } from "../listing.js";
import type { Outcome } from "../page-services.js";
import { type MomentView, momentView } from "../views.js";
import { FULFILLMENT_WORDS, ORDER_WORDS, type Word } from "../words.js";
import type { Operator } from "./access.js";
import { type JournalLineView, journalLinesOf } from "./accounts.js";
import { type ActionAnswer, type ChangeAnswer, pressed } from "./action.js";
import {
  CHECK_WORDS,
  checksSaid,
  cutSaid,
  NO_SELLER_NAME,
  REFUSED_WORDS,
  SEGMENT_WORDS,
  STATE_WORDS,
  WITHDRAWN_WORD,
} from "./merchants-words.js";
import type { AdminParts } from "./parts.js";
import { LOST_ANSWER } from "./words.js";

const PATH = "/admin/merchants";
const SEGMENT_KEYS = ["all", ...MERCHANT_SEGMENTS] as const;
const LIST_ROWS = 50;
const HISTORY_ROWS = 20;
/** An identifier as the product makes them; anything else names no merchant or key. */
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

const at = (instant: number): MomentView => momentView(new Date(instant).toISOString());

const dollars = (amount: string): string => `${amount} USD`;

// --- the list -----------------------------------------------------------------

export interface MerchantListRow {
  readonly id: string;
  readonly href: string;
  /** The seller name, or the words that say there is none. */
  readonly name: string;
  readonly named: boolean;
  /** The shop's site, or where there is none, the account's address; null where neither is known. */
  readonly under: string | null;
  readonly integration: string;
  readonly connection: Readonly<{ said: string; at: MomentView | null }>;
  /** One per check the channel asks, in order; true where it holds. */
  readonly dots: readonly boolean[];
  readonly dotsSaid: string;
  readonly cards: string;
  /** Settled sales over thirty days, or null for none. */
  readonly sales: string | null;
  readonly orders: string;
  readonly lastSale: MomentView | null;
  readonly state: Word;
}

export interface MerchantsView {
  readonly mode: SurfaceMode;
  readonly readAt: MomentView;
  readonly listing: Listing<MerchantListRow>;
  readonly cut: string;
  /** True where the accounts could not be read: no address is shown, and the search did not look at them. */
  readonly accountsUnread: boolean;
  /** True where the search of addresses stopped at the most it reads, so a match may be missing. */
  readonly accountsCut: boolean;
}

/** The account a merchant's row names, or how many where several accounts name it. */
const accountsBy = (accounts: readonly NamedAccount[]) => {
  const by = new Map<string, NamedAccount[]>();
  for (const account of accounts) {
    if (account.merchantId === null) continue;
    by.set(account.merchantId, [...(by.get(account.merchantId) ?? []), account]);
  }
  for (const list of by.values()) list.sort((one, other) => (one.email < other.email ? -1 : 1));
  return by;
};

const integrationWords = (row: Pick<MerchantRow, "integration" | "keys">): string =>
  row.integration === "woocommerce" ? "WooCommerce" : row.keys.issued === 0 ? "None yet" : "SDK";

const connectionOf = (
  row: Pick<MerchantRow, "integration" | "keys" | "lastContactAt">,
): MerchantListRow["connection"] => {
  if (row.integration === "woocommerce")
    return { said: "Selling through a connected shop", at: null };
  if (row.lastContactAt !== null)
    return { said: "Worker last connected", at: at(row.lastContactAt) };
  if (row.keys.working > 0) return { said: "Key issued, never connected", at: null };
  return { said: row.keys.issued === 0 ? "No key issued" : "Every key disabled", at: null };
};

const stateOf = (segment: MerchantSegment): Word => STATE_WORDS[segment];

function listRowOf(
  row: MerchantRow,
  mode: SurfaceMode,
  accounts: readonly NamedAccount[] | null,
): MerchantListRow {
  const asked = askedOn(mode);
  const settled = row.thirtyDays.settled;
  return {
    id: row.id,
    href: `${PATH}/${row.id}`,
    name: row.serviceName ?? NO_SELLER_NAME,
    named: row.serviceName !== null,
    under: row.sellerSite ?? accounts?.[0]?.email ?? null,
    integration: integrationWords(row),
    connection: connectionOf(row),
    dots: asked.map((finding) => !row.missing.includes(finding)),
    dotsSaid: checksSaid(
      row.missing.flatMap((finding) =>
        finding === "no_seller_site" ? [] : [CHECK_WORDS[finding]],
      ),
      asked.length,
    ),
    cards: `${row.cards.onSale} of ${row.cards.published}`,
    sales: settled.count === 0 ? null : dollars(settled.amount),
    orders:
      row.thirtyDays.orders === 0
        ? "No orders"
        : `${row.thirtyDays.orders} ${row.thirtyDays.orders === 1 ? "order" : "orders"}`,
    lastSale: row.lastSaleAt === null ? null : at(row.lastSaleAt),
    state: stateOf(row.segment),
  };
}

// --- one merchant ---------------------------------------------------------------

export interface KeyLine {
  readonly id: string;
  readonly label: string;
  readonly issued: MomentView;
  readonly lastUsed: MomentView | null;
  readonly disabled: MomentView | null;
  /** How this key's own Disable was last answered on this page, or null. */
  readonly answer: ActionAnswer | null;
}

interface ShopFacts {
  readonly url: string;
  readonly connected: MomentView;
  readonly permissions: string;
}

interface WorthLine {
  readonly id: string;
  readonly href: string;
  readonly state: Word;
  readonly title: string;
  readonly price: string;
  readonly when: MomentView;
  /** True where this order's shop order may or may not exist; the merchant recovers it from their own Orders. */
  readonly shopUncertain: boolean;
}

interface CardLine {
  readonly id: string;
  readonly title: string;
  readonly code: string;
  readonly price: string;
  readonly timing: string;
  readonly onSale: boolean;
  readonly paused: boolean;
}

export interface SellingDayView {
  readonly day: string;
  readonly amount: string;
  readonly count: number;
}

export interface MerchantView {
  readonly mode: SurfaceMode;
  readonly readAt: MomentView;
  readonly id: string;
  /** The seller name, or the words that say there is none. */
  readonly name: string;
  /** How the page's sentences call this merchant. */
  readonly called: string;
  readonly site: string | null;
  /** The accounts' addresses, or null where they could not be read. */
  readonly emails: readonly string[] | null;
  readonly since: MomentView;
  readonly state: Word;
  readonly ready: Readonly<{
    sellerName: string | null;
    wallet: Readonly<{
      address: string;
      split: string | null;
      explorer: string | null;
      landsAt: MomentView | null;
    }> | null;
    integration: Readonly<{
      kind: "api" | "woocommerce";
      connection: MerchantListRow["connection"];
      keys: readonly KeyLine[];
      keysCut: string | null;
      /** The connected shop, null where none is, "unread" where its record could not be read. */
      shop: ShopFacts | null | "unread";
    }>;
    /**
     * The answer to a press whose form this page does not draw: a key it does
     * not list, such as another merchant's, or an admission off the live
     * channel. Drawn under the checks, so a step-up or a refusal is never lost.
     */
    strayAnswer: ActionAnswer | null;
    /** Null off the live channel, which asks no admission. */
    admission: Readonly<{
      admittedAt: MomentView | null;
      /** Who admitted, as the history names them, where the journal holds it. */
      admittedBy: string | null;
      /** Null where none stands, "unread" where whether one stands could not be read. */
      withdrawn: Readonly<{ at: MomentView; by: string; note: string | null }> | null | "unread";
      admit: ActionAnswer | null;
      withdraw: ActionAnswer | null;
    }> | null;
  }>;
  readonly selling: Readonly<{
    onSale: number;
    published: number;
    settled: Readonly<{ amount: string; count: number }>;
    orders: number;
    days: readonly SellingDayView[];
  }>;
  readonly cards: Readonly<{ rows: readonly CardLine[]; cut: string | null }>;
  readonly worth: Readonly<{ rows: readonly WorthLine[]; cut: string | null }>;
  /**
   * The journal's rows about this merchant, newest first, drawn as the Journal
   * draws them, or null where they could not be read.
   */
  readonly history: Readonly<{ lines: readonly JournalLineView[]; cut: string | null }> | null;
  /** True where which orders worth a look have an uncertain shop order could not be read. */
  readonly shopOrdersUnread: boolean;
}

/**
 * Who acted, as the history names them: an account by its address, the
 * operator reading the page included, an account that no longer resolves as
 * a deleted one, or by its identifier where the accounts could not be read
 * (`actors` null).
 */
const whoOf = (row: JournalRow, actors: ReadonlyMap<string, string> | null): string => {
  if (row.actor.kind === "terminal") return "the terminal";
  if (row.actor.kind === "configuration") return "the configuration";
  if (actors === null) return `account ${row.actor.id}`;
  return actors.get(row.actor.id) ?? "a deleted account";
};

/** The answers of the page's forms, by which form was pressed. */
export interface Answers {
  readonly admit?: ActionAnswer;
  readonly withdraw?: ActionAnswer;
  readonly key?: Readonly<{ id: string; answer: ActionAnswer }>;
}

/** Everything the Merchants list is drawn from, once read. */
export interface MerchantsRead {
  readonly mode: SurfaceMode;
  readonly readAt: number;
  /** The address's query: the search and the segment. */
  readonly query: URLSearchParams;
  readonly found: MerchantList;
  /** The accounts by merchant, or null where they could not be read. */
  readonly accounts: ReadonlyMap<string, readonly NamedAccount[]> | null;
  /** True where the accounts could not be read or searched. */
  readonly accountsUnread: boolean;
  /** True where the search of addresses stopped at the most it reads. */
  readonly accountsCut: boolean;
}

/** The Merchants list, from what was read. */
export function merchantsViewOf({
  mode,
  readAt,
  query,
  found,
  accounts,
  accountsUnread,
  accountsCut,
}: MerchantsRead): MerchantsView {
  const listed = askedIn(query, SEGMENT_KEYS);
  const rows = found.rows.map((row) => listRowOf(row, mode, accounts?.get(row.id) ?? null));
  const linkTo = (show: string, q: string) => {
    const fields = new URLSearchParams();
    if (q !== "") fields.set("q", q);
    if (show !== "all") fields.set("show", show);
    const written = fields.toString();
    return written === "" ? PATH : `${PATH}?${written}`;
  };
  const nothing = (): Listing<MerchantListRow>["nothing"] => {
    if (rows.length > 0 || (found.segments.all === 0 && listed.q === "")) return null;
    if (listed.q !== "") {
      return {
        says: `No merchant matches “${listed.q}”${listed.show === "all" ? "" : " in this segment"}.`,
        way: { to: linkTo(listed.show, ""), words: "Clear the search" },
      };
    }
    const segmentWords = SEGMENT_WORDS[listed.show as MerchantSegment].toLowerCase();
    return {
      says: `No merchant is ${segmentWords} right now.`,
      way: { to: PATH, words: "Show every merchant" },
    };
  };
  const listing: Listing<MerchantListRow> = {
    rows,
    search: {
      q: listed.q,
      show: listed.show === "all" ? null : listed.show,
      cutAt: listed.cut ? listed.q.length : null,
    },
    segments: SEGMENT_KEYS.map((key) => ({
      key,
      label: SEGMENT_WORDS[key],
      count: found.segments[key],
      to: linkTo(key, listed.q),
      here: key === listed.show,
    })),
    // The list is cut and searched, never paged: the sentence under it says so.
    cut: null,
    nothing: nothing(),
    place: {},
  };
  return {
    mode,
    readAt: at(readAt),
    listing,
    cut: cutSaid(rows.length, found.total),
    accountsUnread: accountsUnread || accounts === null,
    accountsCut,
  };
}

/** Everything a merchant's page is drawn from, once read. */
export interface MerchantRead {
  readonly mode: SurfaceMode;
  /** The chain explorer's page for an address, without the address; null where there is none. */
  readonly addressPage: string | null;
  /** The addresses of the accounts the history names, by identifier, or null where they could not be read. */
  readonly actors: ReadonlyMap<string, string> | null;
  readonly readAt: number;
  readonly record: MerchantRecord;
  /** The accounts' addresses, or null where they could not be read. */
  readonly emails: readonly string[] | null;
  readonly shop: ShopFacts | null | "unread";
  /**
   * The journal's newest rows about the merchant, as read and as the Journal
   * draws them, and how many there are in all, or null where they could not
   * be read.
   */
  readonly history: Readonly<{
    rows: readonly JournalRow[];
    lines: readonly JournalLineView[];
    total: number;
  }> | null;
  /** The withdrawal that stands, whose reason is the note the merchant reads; null for none, "unread" where it could not be read. */
  readonly withdrawal: JournalRow | null | "unread";
  /** The orders worth a look whose shop order may or may not exist, or "unread" where that could not be read. */
  readonly uncertainIds: readonly string[] | "unread";
  readonly answers: Answers;
}

/** A merchant's page, from what was read. */
export function merchantViewOf({
  mode,
  addressPage,
  actors,
  readAt,
  record,
  emails,
  shop,
  history,
  withdrawal,
  uncertainIds,
  answers,
}: MerchantRead): MerchantView {
  const called = record.serviceName ?? "this merchant";
  const keyLabels = new Map(record.keys.rows.map((key) => [key.id, key.label]));
  const admittedRow = history?.rows.find(
    (row) => row.action === "admit" && row.outcome.kind === "done",
  );
  const stands = withdrawal === "unread" ? null : withdrawal;
  const live = mode === "live";
  return {
    mode,
    readAt: at(readAt),
    id: record.id,
    name: record.serviceName ?? NO_SELLER_NAME,
    called,
    site: record.sellerSite,
    emails,
    since: at(record.createdAt),
    state: stands !== null ? WITHDRAWN_WORD : stateOf(record.segment),
    ready: {
      sellerName: record.serviceName,
      wallet:
        record.wallet === null
          ? null
          : {
              address: record.wallet.address,
              split: record.wallet.split,
              explorer:
                record.wallet.split === null || addressPage === null
                  ? null
                  : `${addressPage}${record.wallet.split}`,
              landsAt: record.wallet.pending === null ? null : at(record.wallet.pending.landsAt),
            },
      integration: {
        kind: record.integration,
        connection: connectionOf({
          ...record,
          keys: {
            issued: record.keys.total,
            working: record.keys.working,
          },
        }),
        keys: record.keys.rows.map((key) => ({
          id: key.id,
          label: key.label,
          issued: at(key.createdAt),
          lastUsed: key.lastUsedAt === null ? null : at(key.lastUsedAt),
          disabled: key.disabledAt === null ? null : at(key.disabledAt),
          answer: answers.key?.id === key.id ? answers.key.answer : null,
        })),
        keysCut:
          record.keys.rows.length === record.keys.total
            ? null
            : `${record.keys.rows.length} of ${record.keys.total} keys shown, the newest first`,
        shop,
      },
      admission: live
        ? {
            admittedAt: record.liveApprovedAt === null ? null : at(record.liveApprovedAt),
            admittedBy:
              admittedRow === undefined || record.liveApprovedAt === null
                ? null
                : whoOf(admittedRow, actors),
            withdrawn:
              withdrawal === null || withdrawal === "unread"
                ? withdrawal
                : {
                    at: at(withdrawal.at),
                    by: whoOf(withdrawal, actors),
                    note: withdrawal.reason,
                  },
            admit: answers.admit ?? null,
            withdraw: answers.withdraw ?? null,
          }
        : null,
      strayAnswer:
        answers.key !== undefined && !keyLabels.has(answers.key.id)
          ? answers.key.answer
          : live
            ? null
            : (answers.admit ?? answers.withdraw ?? null),
    },
    selling: {
      onSale: record.cards.onSale,
      published: record.cards.total,
      settled: record.thirtyDays.settled,
      orders: record.thirtyDays.orders,
      days: record.thirtyDays.days,
    },
    cards: {
      rows: record.cards.rows.map((card) => ({
        id: card.id,
        title: card.card.title,
        code: card.card.merchant_item_id,
        price: `${card.card.price.amount} ${card.card.price.currency}`,
        timing: FULFILLMENT_WORDS[card.card.fulfillment ?? "sync"],
        onSale: card.onSale,
        paused: card.paused,
      })),
      cut:
        record.cards.rows.length === record.cards.total
          ? null
          : `${record.cards.rows.length} of ${record.cards.total} cards shown`,
    },
    worth: {
      rows: record.worthALook.rows.map((order) => ({
        id: order.id,
        href: `/admin/orders/${order.id}`,
        state: ORDER_WORDS[order.status],
        title: order.title ?? "A card no longer published",
        price: dollars(order.price.amount),
        when: at(order.createdAt),
        shopUncertain: uncertainIds !== "unread" && uncertainIds.includes(order.id),
      })),
      cut:
        record.worthALook.rows.length === record.worthALook.total
          ? null
          : `${record.worthALook.rows.length} of ${record.worthALook.total} shown, the newest first`,
    },
    shopOrdersUnread: uncertainIds === "unread",
    history:
      history === null
        ? null
        : {
            lines: history.lines,
            cut:
              history.rows.length === history.total
                ? null
                : `The newest ${history.rows.length} of ${history.total} rows; the Journal holds every one.`,
          },
  };
}

/** What a press on a merchant does, as its route names it. */
export type MerchantIntent =
  | Readonly<{ kind: "admit" }>
  | Readonly<{ kind: "withdraw" }>
  | Readonly<{ kind: "disable_key"; keyId: string }>;

export interface MerchantsPages {
  list(operator: Operator, query: URLSearchParams): Promise<Outcome<MerchantsView>>;
  one(operator: Operator, merchantId: string): Promise<Outcome<MerchantView>>;
  /** A press on a merchant's page, answered with the page in its new state. */
  press(
    operator: Operator,
    merchantId: string,
    intent: MerchantIntent,
    form: FormData,
  ): Promise<Outcome<MerchantView | PressedUnread>>;
  /** The Merchants section's count in the sidebar: who waits for admission. */
  counts(operator: Operator): Promise<SectionCounts>;
}

const missing: Outcome<never> = {
  kind: "problem",
  problem: { status: 404, said: "There is no such merchant." },
};

/** A press answered without its page, which could not be read again after the change. */
export interface PressedUnread {
  readonly unread: true;
  readonly merchantId: string;
  /** What the press came to. */
  readonly said: string;
}

/** A press on a merchant's page, in the Journal's verbs, done or only asked. */
const PRESS_WORDS = {
  admit: { done: "Admitted to live sales", asked: "Asked to admit to live sales" },
  withdraw: { done: "Withdrew the admission", asked: "Asked to withdraw the admission" },
  disable_key: { done: "Disabled the key", asked: "Asked to disable the key" },
} as const;

/** What a press on a merchant's page came to, said without the page. */
const pressSaid = (action: keyof typeof PRESS_WORDS, answer: ActionAnswer): string => {
  const words = PRESS_WORDS[action];
  switch (answer.kind) {
    case "done":
      return `${words.done}.`;
    case "unchanged":
      return `${words.asked}: it already stood so, and nothing changed.`;
    case "refused":
      return answer.said;
    case "unknown":
      return LOST_ANSWER;
    case "step-up":
      return "Nothing changed: the press asks for a fresh sign-in first.";
  }
};

export function merchantsFor(parts: AdminParts): MerchantsPages {
  const { config, reader, identity, gateway } = parts;
  const store = gateway.runtime.store;
  const mode = config.surfaceMode;
  const asked = () => ({ at: parts.now().getTime(), surface: mode });

  /** Accounts by merchant, or null where the identity could not answer. */
  const accountsOf = async (merchantIds: readonly string[]) => {
    try {
      return accountsBy(await identity.accountsNamed({ merchantIds }));
    } catch {
      console.error("[dashboard] the accounts behind merchants could not be read");
      return null;
    }
  };

  /** Which of these orders have a shop order nobody is sure of, where the shop could not be read. */
  const unread = async (orderIds: readonly string[]): Promise<readonly string[] | "unread"> =>
    orderIds.length === 0 ? [] : "unread";

  const shopOf = async (accounts: readonly NamedAccount[] | null) => {
    const { shops } = parts;
    if (shops === null) return { shop: null, uncertain: async () => [] };
    if (accounts === null) return { shop: "unread" as const, uncertain: unread };
    try {
      for (const account of accounts) {
        const connection = await shops.connectionOf(account.id);
        if (connection === null) continue;
        return {
          shop: {
            url: connection.shopUrl,
            connected: momentView(connection.connectedAt.toISOString()),
            permissions: connection.permissions,
          } satisfies ShopFacts,
          uncertain: async (orderIds: readonly string[]) =>
            Object.entries(await shops.heldSales(account.id, orderIds)).flatMap(([id, held]) =>
              held === "recoverable" ? [id] : [],
            ),
        };
      }
      return { shop: null, uncertain: async () => [] };
    } catch {
      console.error("[dashboard] a merchant's connected shop could not be read");
      return { shop: "unread" as const, uncertain: unread };
    }
  };

  /** The addresses of the accounts that acted in these rows, or null where they could not be read. */
  const actorsOf = async (
    history: MerchantRead["history"],
    withdrawal: MerchantRead["withdrawal"],
  ): Promise<ReadonlyMap<string, string> | null> => {
    const rows = [
      ...(history?.rows ?? []),
      ...(typeof withdrawal === "object" && withdrawal !== null ? [withdrawal] : []),
    ];
    const accountIds = [
      ...new Set(rows.flatMap((row) => (row.actor.kind === "account" ? [row.actor.id] : []))),
    ];
    if (accountIds.length === 0) return new Map();
    try {
      const named = await identity.accountsNamed({ accountIds });
      return new Map(named.map((account) => [account.id, account.email]));
    } catch {
      console.error("[dashboard] the accounts that acted on a merchant could not be read");
      return null;
    }
  };

  async function pageOf(
    record: MerchantRecord,
    answers: Answers,
    readAt: number,
  ): Promise<MerchantView> {
    const accounts = await accountsOf([record.id]);
    const own = accounts?.get(record.id) ?? (accounts === null ? null : []);
    const { shop, uncertain } = await shopOf(own);
    let history: MerchantRead["history"];
    try {
      const page = await store.journal({ about: { merchant: record.id }, limit: HISTORY_ROWS });
      history = {
        rows: page.rows,
        lines: await journalLinesOf(parts, page.rows),
        total: page.total,
      };
    } catch {
      console.error("[dashboard] a merchant's history could not be read");
      history = null;
    }
    let withdrawal: MerchantRead["withdrawal"] = null;
    try {
      withdrawal =
        record.liveApprovedAt === null ? await store.standingWithdrawal(record.id) : null;
    } catch {
      console.error("[dashboard] a merchant's standing withdrawal could not be read");
      withdrawal = "unread";
    }
    let uncertainIds: MerchantRead["uncertainIds"] = [];
    try {
      uncertainIds = await uncertain(record.worthALook.rows.map((order) => order.id));
    } catch {
      console.error("[dashboard] a merchant's uncertain shop orders could not be read");
      uncertainIds = "unread";
    }

    return merchantViewOf({
      mode,
      addressPage: config.addressPage,
      actors: await actorsOf(history, withdrawal),
      readAt,
      record,
      emails: own === null ? null : own.map((account) => account.email),
      shop,
      history,
      withdrawal,
      uncertainIds,
      answers,
    });
  }

  async function page(
    merchantId: string,
    answers: Answers = {},
    status = 200,
  ): Promise<Outcome<MerchantView>> {
    if (!IDENTIFIER.test(merchantId)) return missing;
    const { at: readAt, surface } = asked();
    const record = await reader.merchants.merchant(merchantId, { at: readAt, surface });
    if (record === null) return missing;
    return { kind: "view", view: await pageOf(record, answers, readAt), status };
  }

  /**
   * The page in its state after a press, or, where it cannot be read again,
   * what the press came to and that the page was not read: the change has
   * committed by then, and a broken page would read as a press to repeat.
   */
  async function pageAfter(
    merchantId: string,
    action: "admit" | "withdraw" | "disable_key",
    answer: ActionAnswer,
    answers: Answers,
  ): Promise<Outcome<MerchantView | PressedUnread>> {
    const status = answer.kind === "refused" ? 409 : 200;
    try {
      return await page(merchantId, answers, status);
    } catch {
      console.error("[dashboard] a merchant's page could not be read again after a press");
      return {
        kind: "view",
        view: { unread: true, merchantId, said: pressSaid(action, answer) },
        status,
      };
    }
  }

  /** The admission's change through the press, refused off the live channel. */
  const admission =
    (merchantId: string, grant: boolean) =>
    async (journal: JournalPress): Promise<ChangeAnswer> => {
      if (mode !== "live") {
        return {
          kind: "refused",
          code: "not_live_channel",
          said: REFUSED_WORDS.not_live_channel ?? "",
        };
      }
      const changed = grant
        ? await grantLiveApproval(store, merchantId, journal.at, journal)
        : await withdrawLiveApproval(store, merchantId, journal);
      if (changed === null) {
        return {
          kind: "refused",
          code: "no_such_merchant",
          said: REFUSED_WORDS.no_such_merchant ?? "",
        };
      }
      return { kind: changed.changed ? "done" : "unchanged" };
    };

  return {
    async list(_operator, query) {
      const listed = askedIn(query, SEGMENT_KEYS);
      const segment = listed.show === "all" ? undefined : (listed.show as MerchantSegment);
      let accountsUnread = false;
      let accountsCut = false;
      let alsoIds: readonly string[] = [];
      if (listed.q !== "") {
        try {
          const found = await identity.accountsWithEmailContaining(listed.q);
          alsoIds = found.accounts.flatMap((account) =>
            account.merchantId === null ? [] : [account.merchantId],
          );
          accountsCut = found.cut;
        } catch {
          console.error("[dashboard] the accounts behind merchants could not be searched");
          accountsUnread = true;
        }
      }
      const { at: readAt, surface } = asked();
      const found = await reader.merchants.list({
        at: readAt,
        surface,
        ...(listed.q === "" ? {} : { search: listed.q, alsoIds }),
        ...(segment === undefined ? {} : { segment }),
        limit: LIST_ROWS,
      });
      const accounts = await accountsOf(found.rows.map((row) => row.id));
      return {
        kind: "view",
        view: merchantsViewOf({
          mode,
          readAt,
          query,
          found,
          accounts,
          accountsUnread,
          accountsCut,
        }),
      };
    },

    one: (_operator, merchantId) => page(merchantId),

    async press(operator, merchantId, intent, form) {
      if (!IDENTIFIER.test(merchantId)) return missing;
      const destination = `admin/merchants/${merchantId}` as const;
      if (intent.kind === "admit" || intent.kind === "withdraw") {
        const answer = await pressed(
          {
            operator,
            form,
            action: intent.kind,
            subject: { kind: "merchant", id: merchantId },
            needsReason: intent.kind === "withdraw",
            destination,
          },
          parts.pressing,
          admission(merchantId, intent.kind === "admit"),
        );
        return await pageAfter(merchantId, intent.kind, answer, {
          [intent.kind]: answer,
        });
      }
      {
        const keyId = intent.keyId;
        if (!IDENTIFIER.test(keyId)) return missing;
        const answer = await pressed(
          {
            operator,
            form,
            action: "disable_key",
            subject: { kind: "key", id: keyId, merchantId },
            needsReason: true,
            destination,
          },
          parts.pressing,
          async (journal) => {
            const disabled = await store.disableKeyOf(merchantId, keyId, journal.at, journal);
            if (disabled === null) {
              return {
                kind: "refused",
                code: "no_such_key",
                said: REFUSED_WORDS.no_such_key ?? "",
              };
            }
            return { kind: disabled.changed ? "done" : "unchanged" };
          },
        );
        return await pageAfter(merchantId, "disable_key", answer, {
          key: { id: keyId, answer },
        });
      }
    },

    async counts() {
      if (mode !== "live") return {};
      const { at: readAt, surface } = asked();
      const found = await reader.merchants.list({
        at: readAt,
        surface,
        segment: "waiting",
        limit: 1,
      });
      return { merchants: { count: found.segments.waiting, needsYou: true } };
    },
  };
}
