import {
  presentShopJob,
  type ShopJobAudience,
  type ShopJobWords,
} from "./shop-job-presentation.js";
import { type JobGroup, type JobProduct, jobIsCurrent, type ShopJob } from "./shop-jobs.js";
import { type MomentView, momentView } from "./views.js";
import type { WooShops } from "./woo-shops.js";
import type { RateView } from "./woo-views.js";
export interface ShopJobState {
  readonly id: string;
  readonly shopHost: string;
  readonly revision: number;
  readonly kind: ShopJob["kind"];
  readonly status: ShopJob["status"];
  readonly read: number;
  readonly total: number | null;
  readonly ready: number;
  readonly published: number;
  readonly excluded: number;
  readonly publicationUnknown: string | null;
  readonly currency: string | null;
  readonly when: MomentView;
  readonly why: string | null;
  readonly stopCode: ShopJob["stopCode"];
  readonly current: boolean;
  readonly groups: readonly {
    readonly group: JobGroup;
    readonly title: string;
    readonly count: number;
    readonly reasons: readonly {
      readonly why: string;
      readonly code: string;
      readonly count: number;
      readonly rows: readonly Pick<JobProduct, "id" | "title" | "why">[];
      readonly more: { readonly href: string; readonly left: number } | null;
    }[];
  }[];
}
type StateGroup = ShopJobState["groups"][number];
export type ShopJobView = Omit<ShopJobState, "groups"> &
  Readonly<{
    words: ShopJobWords;
    initialRate: RateView | null;
    groups: readonly (Omit<StateGroup, "reasons"> &
      Readonly<{
        countText: string;
        reasons: readonly (Omit<StateGroup["reasons"][number], "more"> &
          Readonly<{
            countText: string;
            more: Readonly<{ href: string; left: number; label: string }> | null;
          }>)[];
      }>)[];
  }>;
const GROUPS: readonly [JobGroup, string][] = [
  ["ready", "Ready"],
  ["fix", "To fix in your shop"],
  ["not_selling", "Not for sale in your shop"],
  ["unsupported", "Not supported yet"],
  ["unanswered", "No answer from your shop"],
];
/** Both readers receive this same bounded projection; private shop credentials never enter it. */
export async function shopJobView(
  shops: WooShops,
  merchantId: string,
  query: URLSearchParams,
  audience: ShopJobAudience = "merchant",
): Promise<ShopJobView | null> {
  const snapshots = await shops.jobs.snapshots(merchantId);
  const snapshot =
    snapshots.find(({ job }) => job.status === "queued" || job.status === "running") ??
    snapshots[0];
  if (!snapshot) return null;
  const { job, rows } = snapshot;
  const current = await jobIsCurrent(shops, job);
  const groups = (job.status === "queued" || job.status === "running" ? [] : GROUPS).flatMap(
    ([group, name]) => {
      const found = rows.filter(
        (row) =>
          row.group === group && (group !== "ready" || job.kind !== "publish" || row.published),
      );
      if (!found.length) return [];
      const reasons = new Map<string, JobProduct[]>();
      for (const row of found) {
        const key = row.reason;
        const bucket = reasons.get(key);
        if (bucket) bucket.push(row);
        else reasons.set(key, [row]);
      }
      return [
        {
          group,
          title: group === "ready" && job.kind === "publish" ? "On sale" : name,
          count: found.length,
          reasons: [...reasons].map(([code, entries]) => {
            const key = `show_${group}_${code}`;
            const raw = Number(query.get(key) ?? 10);
            const shown =
              Number.isSafeInteger(raw) && raw >= 10
                ? Math.min(entries.length, 10 + Math.floor((raw - 10) / 50) * 50)
                : 10;
            const next = new URLSearchParams(query);
            next.set(key, String(shown + 50));
            const left = Math.max(0, entries.length - shown);
            const firstWhy = entries[0]?.why ?? "";
            const complete = Object.hasOwn(REASON_LABELS, code) && code !== "ready";
            const sameReason = entries.every((entry) => entry.why === firstWhy);
            const why = complete
              ? (REASON_LABELS[code] ?? "")
              : sameReason
                ? firstWhy
                : "Different shop issues";
            return {
              code,
              why,
              count: entries.length,
              rows: entries.slice(0, shown).map(({ id, title, why: detail }) => ({
                id,
                title,
                why: complete || (sameReason && detail === why) ? "" : detail,
              })),
              more: left ? { href: `?${next}`, left } : null,
            };
          }),
        },
      ];
    },
  );
  return presentShopJob(
    {
      id: job.id,
      shopHost: new URL(job.shopUrl).host,
      revision: job.revision,
      kind: job.kind,
      status: job.status,
      read: job.read,
      total: job.total,
      ready: rows.filter((row) => row.group === "ready").length,
      published: rows.filter((row) => row.published).length,
      excluded:
        job.kind === "publish"
          ? rows.filter(
              (row) =>
                row.group === "ready" && !row.published && row.reason !== "publication_unknown",
            ).length
          : 0,
      publicationUnknown: rows.find((row) => row.reason === "publication_unknown")?.title ?? null,
      currency: job.currency?.code ?? null,
      when: momentView(job.endedAt ?? job.startedAt),
      why: job.why,
      stopCode: job.stopCode,
      current,
      groups,
    },
    audience,
  );
}

const REASON_LABELS: Readonly<Record<string, string>> = {
  ready: "",
  variants: "Has options such as size or colour",
  product_type: "Uses a product type this connection does not support yet",
  stock_tracking: "Uses stock tracking or sells one at a time",
  deleted: "Deleted from your shop",
  out_of_stock: "Out of stock in your shop",
  withdrawn: "Not for sale in your shop",
  seller_paused: "Paused by you in Agentify",
  publication_unknown: "Publication outcome is unknown",
};
