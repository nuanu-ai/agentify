import { keepUnits } from "@agentify/ui/units";
import type { ShopJobState, ShopJobView } from "./shop-job-view.js";
import { initialRateView } from "./woo-views.js";
import type { Word } from "./words.js";

export type ShopJobAudience = "merchant" | "operator";

export interface ShopJobWords {
  readonly connectionState: Word | null;
  readonly reconnectInstruction: string;
  readonly heading: string;
  readonly summary: string;
  readonly progress: string;
  readonly leaving: string;
  readonly outcome: string | null;
  readonly emptyOutcome: string | null;
  readonly outcomeDetail: string | null;
  readonly publicationUnknown: string | null;
  readonly earlier: string | null;
  readonly excluded: string | null;
  readonly sync: string;
  readonly publish: string;
  readonly fix: Readonly<{ lead: string; action: string }> | null;
}

const number = (value: number): string => value.toLocaleString("en-US");
const products = (count: number): string =>
  `${number(count)} ${count === 1 ? "product" : "products"}`;
const stoppedPublicationAt = (view: ShopJobState): string =>
  view.total === null
    ? `${products(view.read)}. The total is unknown.`
    : `${number(view.read)} of ${number(view.total)}.`;

/** Private screen data owns wording; browser code draws these strings as escaped text. */
export function presentShopJob(
  view: ShopJobState,
  audience: ShopJobAudience = "merchant",
): ShopJobView {
  const whole = view.status === "completed" && view.total !== null;
  const scope = whole ? products(view.total ?? view.read) : `${products(view.read)} read`;
  const eligibility = view.current ? "can sell through Agentify" : "could sell at that check";
  const summary =
    view.status === "completed" && view.total === 0
      ? view.current
        ? "Your shop has no products yet."
        : "No products were found at that check."
      : view.read === 0
        ? view.current
          ? "No products have been checked yet."
          : "No products were checked."
        : view.ready === 0
          ? `None of ${whole ? "your" : "the"} ${scope} ${eligibility}${view.current ? " yet" : ""}.`
          : `${number(view.ready)} of ${scope} ${eligibility}.`;
  const read =
    view.total === null
      ? `${products(view.read)} read`
      : `${number(view.read)} of ${products(view.total)} read`;
  const stoppedAt =
    view.total === null
      ? `${products(view.read)}. The total is unknown.`
      : `${number(view.read)} of ${products(view.total)}.`;
  const fullyRead = view.total !== null && view.total > 0 && view.read >= view.total;
  const unanswered = view.groups.some((group) => group.group === "unanswered");
  const fix = view.groups.find((group) => group.group === "fix")?.count ?? 0;
  let outcome =
    view.status === "completed" && view.total === 0
      ? audience === "merchant"
        ? "Add products in your shop, then check again."
        : null
      : view.status === "stopped"
        ? view.kind === "publish" && view.stopCode === "unknown"
          ? `We couldn't confirm the last publication. ${products(view.published)} ${view.published === 1 ? "was" : "were"} confirmed on sale during this publication. ${read}. We don't know about the rest yet.`
          : view.kind === "publish"
            ? view.read === 0
              ? `We couldn't read ${view.shopHost}. No products were confirmed for sale in this sync.`
              : `We published ${products(view.published)} and stopped after ${stoppedPublicationAt(view)} We don't know about the rest yet.`
            : fullyRead
              ? `${read}. ${unanswered ? "Some products could not be checked." : "The work stopped before it finished."}`
              : `Stopped after ${stoppedAt} We don't know about the rest yet.`
        : view.kind === "publish"
          ? view.published === 0
            ? "No products were confirmed for sale in this publication."
            : `${products(view.published)} ${view.published === 1 ? "was" : "were"} confirmed on sale during this publication.`
          : null;
  if (!view.current) {
    const stopped =
      view.status === "stopped"
        ? fullyRead
          ? ` ${read}. ${unanswered ? "Some products could not be checked." : "The work stopped before it finished."}`
          : ` Stopped after ${stoppedAt} We don't know about the rest yet.`
        : "";
    outcome =
      view.kind === "publish"
        ? `${view.stopCode === "unknown" ? "The last publication in this earlier sync was unconfirmed. " : ""}${products(view.published)} ${view.published === 1 ? "was" : "were"} confirmed on sale in this earlier sync.${stopped}`
        : `${summary}${stopped}`;
  }
  return {
    ...view,
    why:
      view.why && !view.current
        ? `Reason recorded then: ${view.why}`
        : view.why && audience === "operator"
          ? `Message for the merchant: ${view.why}`
          : view.why,
    initialRate:
      view.stopCode === "rate_required" && view.currency !== null
        ? initialRateView(view.currency)
        : null,
    words: {
      connectionState:
        view.current && view.stopCode === "reconnect"
          ? { text: "Reconnect required", tone: "warn" }
          : null,
      reconnectInstruction:
        audience === "operator"
          ? "The merchant needs to reconnect their shop, then check again."
          : "Reconnect the shop from its connection settings, then check again.",
      heading: !view.current
        ? view.kind === "check"
          ? "Earlier check result"
          : "Earlier sync result"
        : view.status === "queued" || view.status === "running"
          ? view.kind === "check"
            ? audience === "operator"
              ? "Checking products"
              : "Checking your products"
            : audience === "operator"
              ? "Publishing products"
              : "Publishing your products"
          : view.status === "stopped"
            ? view.kind === "check"
              ? "Check stopped"
              : "Publication stopped"
            : view.kind === "publish"
              ? "Publication result"
              : summary,
      summary,
      progress: `${read}${view.kind === "publish" ? `, ${number(view.published)} ${view.current ? "confirmed on sale" : "confirmed on sale in this earlier sync"}.` : "."}${view.total === null ? " The total is unknown." : ""}`,
      leaving: view.current
        ? `You can leave this page. ${view.kind === "check" ? "The check goes on, and the result waits here." : "The result waits here."}`
        : "Check again for the current shop.",
      outcome,
      emptyOutcome:
        view.current &&
        view.kind === "publish" &&
        view.status === "stopped" &&
        view.stopCode === "unread" &&
        view.read === 0
          ? `We couldn't read ${view.shopHost}, so nothing is on sale yet.`
          : null,
      outcomeDetail:
        view.current &&
        view.status === "stopped" &&
        fullyRead &&
        unanswered &&
        !(view.kind === "publish" && view.stopCode === "unknown")
          ? "See No answer from your shop below."
          : null,
      publicationUnknown: view.publicationUnknown
        ? `Publication of ${view.publicationUnknown} ${view.current ? "is" : "was"} unconfirmed.`
        : null,
      earlier: !view.current
        ? "This result uses an earlier connection or exchange rate. Check again for the current shop."
        : null,
      excluded:
        view.excluded > 0
          ? `${products(view.excluded)} passed the check but ${view.excluded === 1 ? "was" : "were"} paused or unavailable in Agentify then.`
          : null,
      sync: "Syncing makes no duplicates. Products your shop stopped selling come off sale; ones you paused here stay paused.",
      publish: view.kind === "publish" ? "Sync with your shop" : `Publish ${products(view.ready)}`,
      fix:
        fix > 0
          ? {
              lead: `${number(fix)} more ${fix === 1 ? "product" : "products"} can go on sale once you`,
              action: `fix ${fix === 1 ? "it" : "them"} in your shop`,
            }
          : null,
    },
    groups: view.groups.map((group) => ({
      ...group,
      title: view.current
        ? group.title
        : `${group.title} ${view.kind === "publish" ? "in that sync" : "at that check"}`,
      countText: number(group.count),
      reasons: group.reasons.map((reason) => ({
        ...reason,
        countText: number(reason.count),
        rows: reason.rows.map((row) => ({ ...row, title: keepUnits(row.title) })),
        more: reason.more
          ? { ...reason.more, label: `Show 50 more (${number(reason.more.left)} left)` }
          : null,
      })),
    })),
  };
}
