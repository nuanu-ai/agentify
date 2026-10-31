/** The dashboard owns this walk; losing a browser request never owns or cancels it. */
import { readinessOf } from "@agentify/core";
import type { Gateway } from "@agentify/gateway";
import { failureNamed } from "@agentify/gateway/failure-named";
import {
  type CardInput,
  CardSchema,
  MERCHANT_FINDINGS,
  type PublishResult,
  priceProblemsOf,
} from "@nuanu-ai/agentify-contracts";
import { type Acting, type GatewayClient, gatewayFor } from "./gateway.js";
import type { Identity } from "./identity.js";
import { type JobProduct, jobIsCurrent, type ShopJob } from "./shop-jobs.js";
import type { WooWithdrawalReason } from "./woo-card-pauses.js";
import { cardsFromTheShop, productIdFromMerchantItem, type ShopSale } from "./woo-catalog.js";
import {
  type ConnectedCatalogueEvent,
  connectedCatalogue,
  guestCartRefusedWith,
  inspectProductsInTheShop,
  type ProductInspection,
  type ShopKeys,
  withdrawalReason,
} from "./woo-shop.js";
import type { WooShops } from "./woo-shops.js";

export const SHOP_JOB_WORKERS = 4;

interface PublishedShopCard {
  readonly id: string;
  readonly merchantItemId: string;
  readonly title: string;
  readonly paused: boolean;
  readonly connectorPausedAt: number | null;
  readonly selling: boolean;
}
/** The walk knows card contracts and outcomes, not how the publisher delivers them. */
export interface ShopPublisher {
  publish(card: CardInput): Promise<PublishResult | null>;
  cards(): Promise<readonly PublishedShopCard[]>;
  read(id: string): Promise<PublishedShopCard | null>;
  pause(id: string, reason: WooWithdrawalReason | null): Promise<void>;
}
export function shopPublisherFor(
  application: Gateway,
  acting: Acting,
  shops: WooShops,
): ShopPublisher {
  const gateway = gatewayFor(application, acting, undefined, shops.cardPauses);
  return {
    async publish(card) {
      try {
        const answer = await gateway.publishCard(card);
        return answer.ok ? answer.document : null;
      } catch {
        return null;
      }
    },
    async cards() {
      const [stored, visible] = await Promise.all([
        application.runtime.store.cards(acting.merchantId),
        gateway.cards(),
      ]);
      if (!visible.ok) throw new Error("The published products could not be read.");
      const selling = new Map(
        visible.document.cards.map((card) => [card.id, card.selling === "open"]),
      );
      return stored
        .filter((card) => card.integration === "woocommerce")
        .map((card) => ({
          id: card.id,
          merchantItemId: card.card.merchant_item_id,
          title: card.card.title,
          paused: card.paused,
          connectorPausedAt: visible.document.integrationPauses?.[card.id]?.at ?? null,
          selling: selling.get(card.id) === true,
        }));
    },
    async read(id) {
      const [stored, visible, connectorPausedAt] = await Promise.all([
        application.runtime.store.cardById(id),
        application.merchantCard(acting.merchantId, id),
        shops.cardPauses.withLock(
          acting.merchantId,
          id,
          async (ownership) => ownership.pause?.at ?? null,
        ),
      ]);
      return stored?.merchantId === acting.merchantId &&
        stored.integration === "woocommerce" &&
        visible !== null
        ? {
            id,
            merchantItemId: stored.card.merchant_item_id,
            title: stored.card.title,
            paused: stored.paused,
            connectorPausedAt,
            selling: visible.selling === "open",
          }
        : null;
    },
    async pause(id, reason) {
      await shops.cardPauses.set(acting.merchantId, id, reason, application.runtime.store);
    },
  };
}
export interface ShopWorkParts {
  readonly shops: WooShops;
  readonly advancePublications?: () => Promise<void>;
  readonly identity: Pick<Identity, "byId">;
  readonly clientFor: (acting: Acting) => GatewayClient;
  readonly publisherFor: (acting: Acting) => ShopPublisher;
  readonly catalogue?: (keys: ShopKeys) => AsyncIterable<ConnectedCatalogueEvent>;
  readonly inspect?: (
    keys: ShopKeys,
    merchantItemIds: readonly string[],
  ) => Promise<readonly ProductInspection[]>;
  readonly guestCart?: (url: string) => Promise<number | null>;
  readonly surfaceMode: Parameters<typeof readinessOf>[1];
}
const stopped = (code: NonNullable<ShopJob["stopCode"]>, why: string | null) => ({
  status: "stopped" as const,
  stopCode: code,
  why,
});
export async function workShopJob(
  job: ShopJob,
  parts: ShopWorkParts,
  stopping: () => boolean = () => false,
): Promise<void> {
  const { shops } = parts;
  let publisher: ShopPublisher | undefined;
  const finish = async (result: Parameters<typeof shops.jobs.finish>[1]) => {
    if (job.kind === "publish" && publisher !== undefined) {
      // One terminal snapshot catches pauses made during the walk without reading the catalogue per row.
      const [cards, rows] = await Promise.all([
        publisher.cards(),
        shops.jobs.rows(job.merchantId, job.id),
      ]);
      const selling = new Map(
        cards.map((card) => [
          productIdFromMerchantItem(job.shopUrl, card.merchantItemId),
          card.selling,
        ]),
      );
      for (const row of rows) {
        if (row.group !== "ready" || row.reason === "publication_unknown") continue;
        const published = selling.get(row.id) === true;
        if (published !== row.published)
          await shops.jobs.record(
            job.id,
            {
              ...row,
              published,
              why: published ? "" : "Sales are paused or not available in Agentify.",
            },
            null,
          );
      }
    }
    await shops.jobs.finish(job.id, result);
  };
  const person = await parts.identity.byId(job.accountId);
  const connection = await shops.connectionOf(job.accountId);
  if (person?.merchant?.id !== job.merchantId || connection?.revision !== job.connectionRevision)
    return finish(stopped("changed", "The connected shop changed. Check your products again."));
  if (!(await jobIsCurrent(shops, job)))
    return finish(
      stopped("changed", "The connection or exchange rate changed. Check your products again."),
    );
  if (connection.permissions !== "read_write")
    return finish(stopped("reconnect", "Reconnect your shop with read and write access."));
  const acting = { merchantId: job.merchantId, email: person.email };
  const gateway = parts.clientFor(acting);
  if (job.kind === "publish") {
    const [seller, wallet, approval, integration] = await Promise.all([
      gateway.seller(),
      gateway.payoutWallet(),
      gateway.liveApproval(),
      gateway.integration(),
    ]);
    if (!seller.ok || !wallet.ok || !approval.ok || !integration.ok)
      return finish(stopped("internal", null));
    const door = readinessOf(
      {
        sellerName: seller.document.name,
        payoutWallet: wallet.document.payout_wallet,
        liveApproval: approval.document,
      },
      parts.surfaceMode,
    );
    if (
      !seller.document.site ||
      door.missing.length > 0 ||
      door.unknown.length > 0 ||
      integration.document.through !== "woocommerce"
    )
      return finish(
        stopped(
          "changed",
          "Finish your account settings and live approval before publishing. Nothing was published.",
        ),
      );
  }
  publisher = parts.publisherFor(acting);
  const existing = job.kind === "publish" ? await publisher.cards() : [];
  const byProduct = new Map(
    existing.flatMap((card) => {
      const id = productIdFromMerchantItem(job.shopUrl, card.merchantItemId);
      return id === null ? [] : [[id, card] as const];
    }),
  );
  const seen = new Set<string>();
  const withdrawals = new Map<string, WooWithdrawalReason>();
  let sale: ShopSale | null = null;
  let basis = job;
  let complete = false;
  let total: number | null = null;
  let cart: number | null | undefined;
  const current = async () => !stopping() && (await jobIsCurrent(shops, basis)) && !stopping();
  for await (const event of (parts.catalogue ?? connectedCatalogue)(connection)) {
    if (!(await current()))
      return finish(
        stopping()
          ? stopped(
              "interrupted",
              `The server stopped before the work finished. ${job.kind === "publish" ? "Sync with your shop." : "Check again."}`,
            )
          : stopped("changed", "The connection or rate changed. Check your products again."),
      );
    if (event.kind === "stopped")
      return finish(
        stopped(
          event.reconnect ? "reconnect" : "unread",
          event.reconnect ? "Your shop refused access. Reconnect it, then check again." : event.why,
        ),
      );
    if (event.kind === "total") {
      total = event.total;
      await shops.jobs.total(job.id, total);
      continue;
    }
    if (event.kind === "currency") {
      if (!(await jobIsCurrent(shops, basis, event.currency)))
        return finish(
          stopped("changed", "The connection or exchange rate changed. Check your products again."),
        );
      await shops.noteCurrency(job.accountId, event.currency, job.connectionRevision);
      await shops.jobs.currency(job.id, event.currency);
      const rate =
        event.currency.code === "USD"
          ? null
          : await shops.currentRate(
              job.accountId,
              new URL(job.shopUrl).origin,
              event.currency.code,
            );
      if (!(await jobIsCurrent(shops, basis, event.currency)))
        return finish(
          stopped("changed", "The connection or exchange rate changed. Check your products again."),
        );
      if (event.currency.code !== "USD" && rate === null)
        return finish(stopped("rate_required", "Save an exchange rate to check your products."));
      sale = {
        currency: event.currency.code,
        decimals: event.currency.decimals,
        rate: rate?.rate ?? null,
      };
      basis = {
        ...job,
        currency: event.currency,
        rate: rate === null ? null : { ...rate, setAt: rate.setAt.toISOString() },
      };
      await shops.jobs.rate(job.id, rate);
      continue;
    }
    if (event.kind === "complete") {
      complete = true;
      continue;
    }
    if (sale === null) return finish(stopped("unread", "The shop's currency could not be read."));
    const id = String(event.product.id);
    seen.add(id);
    const title = event.product.name;
    const row: JobProduct = {
      id,
      title,
      group: "ready",
      reason: "ready",
      why: "",
      published: false,
    };
    let verdict = row;
    const inspected = event.inspected;
    if (!inspected.ok) {
      const obstacle = !inspected.again ? inspected.obstacle : undefined;
      verdict = {
        ...row,
        group: obstacle?.group ?? (inspected.again || !inspected.saidNo ? "unanswered" : "fix"),
        reason: obstacle?.reason ?? "shop_check",
        why: inspected.why,
      };
      const reason = withdrawalReason(obstacle);
      if (reason && byProduct.has(id)) withdrawals.set(id, reason);
    } else {
      if (inspected.product.kind === "parcel" && cart === undefined)
        cart = await (parts.guestCart ?? guestCartRefusedWith)(connection.shopUrl);
      const mapped = cardsFromTheShop([event.product], connection.shopUrl, sale);
      const card = mapped.cards[0]?.card;
      const skipped = mapped.skipped[0];
      if (inspected.product.kind === "parcel" && cart !== null)
        verdict = {
          ...row,
          group: "fix",
          reason: "cart",
          why: "Your shop would not open a visitor cart. Allow access to WooCommerce's cart, then check again.",
        };
      else if (!card)
        verdict = {
          ...row,
          group: skipped?.fixable === false ? "unsupported" : "fix",
          reason: "product_content",
          why: skipped?.why ?? "This product could not be read.",
        };
      else {
        const parsed = CardSchema.safeParse(card);
        const problems = parsed.success ? priceProblemsOf(parsed.data.price) : parsed.error.issues;
        if (problems.length)
          verdict = {
            ...row,
            group: "fix",
            reason: "card",
            why: problems.map((one) => one.message).join(" "),
          };
        else if (job.kind === "publish") {
          const prior = byProduct.get(id);
          if (prior?.paused && prior.connectorPausedAt === null)
            verdict = { ...row, why: "Paused by you in Agentify.", reason: "seller_paused" };
          else {
            if (!(await current()))
              return finish(stopped("changed", "The connection or rate changed. Sync again."));
            const published = await publisher.publish(card);
            if (published === null) {
              await shops.jobs.record(
                job.id,
                {
                  ...row,
                  group: "ready",
                  reason: "publication_unknown",
                  publication: "unknown",
                  why: "We don't know whether this product was published.",
                },
                total,
              );
              return finish(
                stopped("unknown", "Publication stopped. We don't know about the rest yet."),
              );
            }
            if (!published.ok) {
              if (
                published.error.problems.some((problem) =>
                  Object.values(MERCHANT_FINDINGS).some((code) => code === problem.code),
                )
              ) {
                await shops.jobs.record(job.id, { ...row, publication: "refused" }, total);
                return finish(
                  stopped(
                    "changed",
                    "Publication stopped because your account settings or live approval changed. Review Settings and your live approval before publishing again.",
                  ),
                );
              }
              verdict = {
                ...row,
                group: "fix",
                reason: "publication",
                publication: "refused",
                why: published.error.problems.map((one) => one.message).join(" "),
              };
            } else {
              if (prior?.connectorPausedAt !== null && prior !== undefined) {
                if (!(await current())) {
                  await shops.jobs.record(job.id, { ...row, publication: "accepted" }, total);
                  return finish(stopped("changed", "The connection or rate changed. Sync again."));
                }
                await publisher.pause(prior.id, null);
              }
              const publishedCard = await publisher.read(published.id);
              verdict = {
                ...row,
                published: publishedCard?.selling === true,
                publication: "accepted",
                why: publishedCard?.selling
                  ? ""
                  : "Published, but sales are paused or not available yet.",
              };
            }
          }
        }
      }
    }
    await shops.jobs.record(job.id, verdict, total);
    if (!inspected.ok && !inspected.again && inspected.reconnect)
      return finish(stopped("reconnect", inspected.why));
  }
  if (!complete)
    return finish(
      stopped("unread", "The catalogue read did not finish. We don't know about the rest yet."),
    );
  // A complete list still cannot establish why a known product was omitted.
  // A card the connector withdrew stays withdrawn until its product is listed again, which the
  // list above already handles, so asking after it again would only repeat the shop's answer.
  let directlyRead = 0;
  const missing = [...byProduct].filter(
    ([id, card]) => !seen.has(id) && !(card.paused && card.connectorPausedAt !== null),
  );
  total = seen.size + missing.length;
  await shops.jobs.total(job.id, total);
  if (!(await current()))
    return finish(stopped("changed", "The connection or rate changed. Sync again."));
  const inspections =
    missing.length === 0
      ? []
      : await (parts.inspect ?? inspectProductsInTheShop)(
          connection,
          missing.map(([, card]) => card.merchantItemId),
        );
  if (!(await current()))
    return finish(stopped("changed", "The connection or rate changed. Sync again."));
  for (const [index, [id, card]] of missing.entries()) {
    const inspected = inspections[index];
    if (inspected === undefined)
      throw new Error("The shop's answers did not match the products asked about.");
    directlyRead++;
    if (!inspected.ok) {
      const obstacle = inspected.again ? undefined : inspected.obstacle;
      const reason = withdrawalReason(obstacle);
      if (reason) withdrawals.set(id, reason);
      await shops.jobs.record(
        job.id,
        {
          id,
          title: card.title,
          group: obstacle?.group ?? "unanswered",
          reason: obstacle?.reason ?? "shop_check",
          why: inspected.why,
          published: false,
        },
        total,
      );
      if (!inspected.again && inspected.reconnect)
        return finish(stopped("reconnect", inspected.why));
    } else {
      await shops.jobs.record(
        job.id,
        {
          id,
          title: card.title,
          group: "unanswered",
          reason: "catalogue_changed",
          why: "The product is available but was missing from the catalogue. Check again.",
          published: false,
        },
        total,
      );
    }
  }
  if (job.kind === "publish") {
    for (const [id, reason] of withdrawals) {
      if (!(await current()))
        return finish(stopped("changed", "The connection or rate changed. Sync again."));
      const card = byProduct.get(id);
      if (card) await publisher.pause(card.id, reason);
    }
  }
  // The final count is known only after the complete traversal.
  await shops.jobs.total(job.id, seen.size + directlyRead);
  await finish({ status: "completed", why: null, stopCode: null });
}

export function startShopJobs(parts: ShopWorkParts): {
  stop(): Promise<void>;
  ready: Promise<void>;
} {
  let stopping = false;
  const wakes = new Set<() => void>();
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        wakes.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      wakes.add(wake);
    });
  const reconcile = async () => {
    await parts.advancePublications?.();
    await parts.shops.jobs.interrupted();
    // A renewed grant or first rate remains durable when enqueue met another active job.
    for (const connection of await parts.shops.connections()) {
      if (stopping) return;
      if (connection.permissions !== "read_write") continue;
      const person = await parts.identity.byId(connection.accountId);
      if (!person?.merchant) continue;
      const latest = await parts.shops.jobs.latest(person.merchant.id);
      if (latest.some((one) => one.status === "queued" || one.status === "running")) continue;
      const same = latest.find((one) => one.connectionRevision === connection.revision);
      const rate =
        connection.currency && connection.currency.code !== "USD"
          ? await parts.shops.currentRate(
              connection.accountId,
              new URL(connection.shopUrl).origin,
              connection.currency.code,
            )
          : null;
      if (!same || (same.stopCode === "rate_required" && rate !== null))
        await parts.shops.jobs.request({
          merchantId: person.merchant.id,
          accountId: connection.accountId,
          connectionRevision: connection.revision,
          shopUrl: connection.shopUrl,
          kind: "check",
        });
    }
  };
  const ready = (async () => {
    while (!stopping) {
      try {
        await parts.shops.jobs.interrupted();
        return;
      } catch (error) {
        console.error(`[dashboard] shop work recovery could not continue: ${failureNamed(error)}`);
        if (!stopping) await wait(1000);
      }
    }
  })();
  const recovery = (async () => {
    await ready;
    while (!stopping) {
      try {
        await reconcile();
      } catch (error) {
        console.error(`[dashboard] shop work recovery could not continue: ${failureNamed(error)}`);
      }
      if (!stopping) await wait(30_000);
    }
  })();
  const work = async () => {
    await ready;
    let unfinished: ShopJob | null = null;
    while (!stopping) {
      try {
        if (unfinished !== null) {
          await parts.shops.jobs.finish(
            unfinished.id,
            stopped("unknown", "The work stopped. We don't know about the rest yet."),
          );
          unfinished = null;
        }
        const job = await parts.shops.jobs.claim();
        if (!job) {
          if (!stopping) await wait(1000);
          continue;
        }
        unfinished = job;
        try {
          await workShopJob(job, parts, () => stopping || !parts.shops.jobs.owns(job.id));
        } catch {
          await parts.shops.jobs.finish(
            job.id,
            stopped("unknown", "The work stopped. We don't know about the rest yet."),
          );
        }
        unfinished = null;
      } catch (error) {
        console.error(`[dashboard] shop work could not continue: ${failureNamed(error)}`);
        if (!stopping) await wait(1000);
      }
    }
  };
  const workers = Array.from({ length: SHOP_JOB_WORKERS }, work);
  return {
    ready,
    async stop() {
      stopping = true;
      for (const wake of wakes) wake();
      await Promise.all([recovery, ...workers]);
      await parts.shops.jobs.close();
    },
  };
}
