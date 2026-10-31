/** Durable shop work. Product rows retain observations; a stopped walk never proves absence. */
import { randomUUID } from "node:crypto";
import { recordAlong, type SetupResult } from "@agentify/gateway/analytics";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { captureLivePublication } from "./live-sales-publication.js";
import { livePublications, shopJobProducts, shopJobs } from "./schema.js";
import type { AppliedRate, ShopCurrency, WooShops } from "./woo-shops.js";

type JobKind = "check" | "publish";
export type JobGroup = "ready" | "fix" | "not_selling" | "unsupported" | "unanswered";
export interface JobProduct {
  readonly id: string;
  readonly title: string;
  readonly group: JobGroup;
  readonly reason: string;
  readonly why: string;
  readonly published: boolean;
  readonly publication?: "accepted" | "refused" | "unknown";
}
export interface ShopJob {
  readonly id: string;
  readonly publicationId?: string;
  readonly merchantId: string;
  readonly accountId: string;
  readonly connectionRevision: string;
  readonly shopUrl: string;
  readonly kind: JobKind;
  readonly status: "queued" | "running" | "completed" | "stopped";
  readonly sequence: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly revision: number;
  readonly read: number;
  readonly total: number | null;
  readonly why: string | null;
  readonly stopCode:
    | "interrupted"
    | "rate_required"
    | "reconnect"
    | "changed"
    | "unread"
    | "internal"
    | "unknown"
    | null;
  readonly currency: ShopCurrency | null;
  readonly rate: {
    readonly version: number;
    readonly currency: string;
    readonly rate: string;
    readonly setAt: string;
  } | null;
}
export type JobRequest = Pick<
  ShopJob,
  "merchantId" | "accountId" | "connectionRevision" | "shopUrl"
> &
  (
    | { readonly kind: "check" }
    | {
        readonly kind: "publish";
        readonly publicationId?: string;
        readonly currency: ShopCurrency;
        readonly rate: ShopJob["rate"];
      }
  );
const requirePublicationBasis = (input: JobRequest): void => {
  if (input.kind !== "publish") return;
  if (
    !input.currency ||
    !Number.isInteger(input.currency.decimals) ||
    input.currency.decimals < 0 ||
    (input.currency.code === "USD"
      ? input.rate !== null
      : !input.rate ||
        input.rate.currency !== input.currency.code ||
        !Number.isSafeInteger(input.rate.version) ||
        input.rate.version < 1)
  )
    throw new Error("Publication requires the checked currency and exchange rate.");
};
type JobFinish = Pick<ShopJob, "why" | "stopCode"> & {
  readonly status: "completed" | "stopped";
};
export interface ShopJobs {
  request(input: JobRequest): Promise<{ accepted: boolean; job: ShopJob }>;
  claim(): Promise<ShopJob | null>;
  owns(id: string): boolean;
  close(): Promise<void>;
  record(id: string, product: JobProduct, total: number | null): Promise<void>;
  total(id: string, total: number | null): Promise<void>;
  currency(id: string, currency: ShopCurrency): Promise<void>;
  rate(id: string, rate: AppliedRate | null): Promise<void>;
  finish(id: string, result: JobFinish): Promise<void>;
  interrupted(): Promise<void>;
  snapshots(merchantId: string): Promise<readonly { job: ShopJob; rows: readonly JobProduct[] }[]>;
  latest(merchantId: string): Promise<readonly ShopJob[]>;
  rows(merchantId: string, jobId: string): Promise<readonly JobProduct[]>;
}
/** Agentify stopped before reading a single product, so the job says nothing about the shop. */
export const stoppedOnOurSide = (job: Pick<ShopJob, "stopCode" | "read">): boolean =>
  job.stopCode === "internal" ||
  ((job.stopCode === "interrupted" || job.stopCode === "unknown") && job.read === 0);
const active = (job: ShopJob) => job.status === "queued" || job.status === "running";
const fresh = (input: JobRequest, sequence: number): ShopJob => ({
  ...input,
  sequence,
  id: randomUUID(),
  status: "queued",
  startedAt: new Date().toISOString(),
  endedAt: null,
  revision: 0,
  read: 0,
  total: null,
  why: null,
  stopCode: null,
  currency: input.kind === "publish" ? input.currency : null,
  rate: input.kind === "publish" ? input.rate : null,
});
const interrupted: JobFinish = {
  status: "stopped",
  why: "The work was interrupted. We don't know about the rest yet.",
  stopCode: "interrupted",
};
const rateValue = (rate: AppliedRate | null): ShopJob["rate"] =>
  rate === null ? null : { ...rate, setAt: rate.setAt.toISOString() };

type ImportResult = Extract<SetupResult, { readonly fields: { readonly step: "woo_import" } }>;
const terminalImportResult = (job: ShopJob, rows: readonly JobProduct[]): ImportResult => {
  const imported = rows.filter((row) => row.publication === "accepted").length;
  const failed = rows.filter(
    (row) => row.publication === "refused" || row.publication === "unknown",
  ).length;
  const settled =
    job.status !== "completed"
      ? {
          outcome: "unknown" as const,
          reason_code: rows.some((row) => row.publication === "unknown")
            ? ("internal_error" as const)
            : job.stopCode === "unread"
              ? ("catalogue_unavailable" as const)
              : ("unknown" as const),
        }
      : failed === 0
        ? { outcome: "completed" as const }
        : imported > 0
          ? { outcome: "partial" as const }
          : { outcome: "blocked" as const, reason_code: "invalid_input" as const };
  return {
    name: "agc_setup_result",
    actor: "human",
    source: "dashboard",
    refs: { merchant: job.merchantId, person: job.accountId },
    fields: {
      step: "woo_import",
      integration: "woocommerce",
      ...settled,
      imported_count: imported,
      failed_count: failed,
      skipped_count: rows.length - imported - failed,
    },
  };
};

const terminalResult = (job: ShopJob, rows: readonly JobProduct[]): SetupResult => {
  const failure =
    job.stopCode === "reconnect"
      ? ({ outcome: "blocked", reason_code: "no_connection" } as const)
      : job.stopCode === "rate_required"
        ? ({ outcome: "blocked", reason_code: "invalid_input" } as const)
        : ({
            outcome: "unknown",
            reason_code: job.stopCode === "unread" ? "catalogue_unavailable" : "unknown",
          } as const);
  const refs = { merchant: job.merchantId, person: job.accountId };
  if (job.kind === "check")
    return {
      name: "agc_setup_result",
      actor: "system",
      source: "woocommerce",
      refs,
      fields: {
        step: "woo_check",
        integration: "woocommerce",
        ...(job.status === "completed" ? ({ outcome: "completed" } as const) : failure),
        observed_ready_count: rows.filter((row) => row.group === "ready").length,
        observed_read_count: job.read,
      },
    };
  const result = terminalImportResult(job, rows);
  return job.publicationId === undefined
    ? result
    : { ...result, actor: "system", source: "woocommerce" };
};

export function memoryShopJobs(record?: (event: SetupResult, at: Date) => void): ShopJobs {
  const jobs = new Map<string, ShopJob>();
  const products = new Map<string, Map<string, JobProduct>>();
  const held = new Set<string>();
  const update = (id: string, change: Partial<ShopJob>) => {
    const before = jobs.get(id);
    if (before?.status !== "running" || !held.has(id)) return;
    const job = { ...before, ...change, revision: before.revision + 1 };
    jobs.set(id, job);
    if (job.status === "completed" || job.status === "stopped") {
      held.delete(id);
      try {
        record?.(
          terminalResult(job, [...(products.get(id)?.values() ?? [])]),
          new Date(job.endedAt ?? Date.now()),
        );
      } catch {
        console.error("[analytics] a shop result could not be recorded");
      }
    }
  };
  return {
    owns: (id) => held.has(id),
    async close() {
      held.clear();
    },
    async request(input) {
      requirePublicationBasis(input);
      const running = [...jobs.values()].find(
        (one) => one.merchantId === input.merchantId && active(one),
      );
      if (running)
        return {
          accepted:
            running.kind === input.kind && running.connectionRevision === input.connectionRevision,
          job: structuredClone(running),
        };
      const sequence =
        Math.max(
          0,
          ...[...jobs.values()]
            .filter((one) => one.merchantId === input.merchantId)
            .map((one) => one.sequence),
        ) + 1;
      for (const [id, job] of jobs)
        if (job.merchantId === input.merchantId && job.kind === input.kind) {
          jobs.delete(id);
          products.delete(id);
        }
      const job = fresh(input, sequence);
      jobs.set(job.id, job);
      products.set(job.id, new Map());
      return { accepted: true, job: structuredClone(job) };
    },
    async claim() {
      const job = [...jobs.values()].find((one) => one.status === "queued");
      if (!job) return null;
      const claimed = { ...job, status: "running" as const, revision: job.revision + 1 };
      jobs.set(job.id, claimed);
      held.add(job.id);
      return structuredClone(claimed);
    },
    async record(id, product, total) {
      const job = jobs.get(id);
      if (job?.status !== "running" || !held.has(id)) return;
      const rows = products.get(id);
      if (!rows) return;
      rows.set(product.id, structuredClone(product));
      update(id, { read: rows.size, total: total ?? job.total });
    },
    async total(id, total) {
      update(id, { total });
    },
    async currency(id, currency) {
      update(id, { currency });
    },
    async rate(id, rate) {
      update(id, { rate: rateValue(rate) });
    },
    async finish(id, result) {
      update(id, { ...result, endedAt: new Date().toISOString() });
    },
    async interrupted() {
      for (const [id, job] of jobs)
        if (job.status === "running" && !held.has(id)) {
          held.add(id);
          update(id, { ...interrupted, endedAt: new Date().toISOString() });
        }
    },
    async snapshots(merchantId) {
      return structuredClone(
        [...jobs.values()]
          .filter((job) => job.merchantId === merchantId)
          .sort((a, b) => b.sequence - a.sequence)
          .map((job) => ({ job, rows: [...(products.get(job.id)?.values() ?? [])] })),
      );
    },
    async latest(merchantId) {
      return structuredClone(
        [...jobs.values()].filter((one) => one.merchantId === merchantId).reverse(),
      );
    },
    async rows(merchantId, id) {
      return jobs.get(id)?.merchantId === merchantId
        ? structuredClone([...(products.get(id)?.values() ?? [])])
        : [];
    },
  };
}

/** Also used inside connection/rate writes, so a saved trigger cannot lose its task. */
export async function requestShopJob(
  tx: Pick<ReturnType<typeof drizzle>, "execute" | "select" | "delete" | "insert" | "update">,
  input: JobRequest,
): Promise<{ accepted: boolean; job: ShopJob }> {
  requirePublicationBasis(input);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.merchantId}, 149))`);
  const publicationId = input.kind === "publish" ? input.publicationId : undefined;
  const [intent] =
    publicationId === undefined
      ? []
      : await tx
          .select()
          .from(livePublications)
          .where(eq(livePublications.id, publicationId))
          .for("update");
  if (
    publicationId !== undefined &&
    (!intent ||
      intent.state !== "pending" ||
      intent.merchantId !== input.merchantId ||
      intent.accountId !== input.accountId)
  )
    throw new Error("the automatic publication is no longer pending");
  const previous = await tx
    .select()
    .from(shopJobs)
    .where(eq(shopJobs.merchantId, input.merchantId));
  const running = previous.find((one) => one.status === "queued" || one.status === "running");
  if (running)
    return {
      accepted:
        running.kind === input.kind &&
        running.data.connectionRevision === input.connectionRevision &&
        running.data.publicationId === publicationId,
      job: running.data,
    };
  await tx
    .delete(shopJobs)
    .where(and(eq(shopJobs.merchantId, input.merchantId), eq(shopJobs.kind, input.kind)));
  const job = fresh(input, Math.max(0, ...previous.map((one) => one.data.sequence)) + 1);
  await tx.insert(shopJobs).values({
    id: job.id,
    merchantId: input.merchantId,
    accountId: input.accountId,
    kind: input.kind,
    status: job.status,
    data: job,
  });
  if (publicationId !== undefined)
    await tx
      .update(livePublications)
      .set({ jobId: job.id })
      .where(eq(livePublications.id, publicationId));
  return { accepted: true, job };
}

export function postgresShopJobs(pool: Pool, ownershipPool: Pool = pool): ShopJobs {
  const db = drizzle(pool);
  type Owner = { client: PoolClient; pending: Promise<void>; release(): void };
  const owners = new Map<string, Owner>();
  const owned = async (id: string, work: (client: PoolClient) => Promise<void>) => {
    const owner = owners.get(id);
    if (!owner) return;
    const next = owner.pending.then(async () => {
      if (owners.get(id) === owner) await work(owner.client);
    });
    owner.pending = next.catch(() => {});
    await next;
  };
  const take = async (status: "queued" | "running", id?: string): Promise<ShopJob | null> => {
    // Recovery must stay available when every long-lived worker session is occupied.
    const client = await (status === "queued" ? ownershipPool : pool).connect();
    let retained = false;
    let released = false;
    let jobId: string | undefined;
    // A dedicated session owns the walk without an expiring lease or a long transaction.
    const release = () => {
      if (released) return;
      released = true;
      if (jobId !== undefined) owners.delete(jobId);
      client.release(true);
    };
    client.on("error", release);
    client.on("end", release);
    try {
      const job = await drizzle(client).transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(shopJobs)
          .where(
            and(eq(shopJobs.status, status), id === undefined ? undefined : eq(shopJobs.id, id)),
          )
          .orderBy(asc(shopJobs.id))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!row) return null;
        const lock = await tx.execute(
          sql`select pg_try_advisory_lock(hashtextextended(${row.id}, 150)) as held`,
        );
        if (lock.rows[0]?.held !== true) return null;
        jobId = row.id;
        const job: ShopJob = { ...row.data, status: "running", revision: row.data.revision + 1 };
        if (status === "queued")
          await tx
            .update(shopJobs)
            .set({ status: job.status, data: job })
            .where(eq(shopJobs.id, job.id));
        return status === "queued" ? job : row.data;
      });
      if (job && !released) {
        owners.set(job.id, { client, pending: Promise.resolve(), release });
        retained = true;
        return job;
      }
      return null;
    } finally {
      if (!retained) {
        if (jobId === undefined && !released) {
          released = true;
          client.removeListener("error", release);
          client.removeListener("end", release);
          client.release();
        } else release();
      }
    }
  };
  const update = async (id: string, change: (job: ShopJob) => Partial<ShopJob>) =>
    owned(id, async (client) => {
      const terminal = await drizzle(client).transaction(async (tx) => {
        const [row] = await tx.select().from(shopJobs).where(eq(shopJobs.id, id)).for("update");
        if (row?.status !== "running") return true;
        const data = { ...row.data, ...change(row.data), revision: row.data.revision + 1 };
        if (data.status === "completed" || data.status === "stopped")
          await captureLivePublication(tx, data);
        await tx.update(shopJobs).set({ data, status: data.status }).where(eq(shopJobs.id, id));
        if (data.status === "completed" || data.status === "stopped") {
          try {
            await tx.transaction(async (observation) => {
              const rows = await observation
                .select({ data: shopJobProducts.data })
                .from(shopJobProducts)
                .where(eq(shopJobProducts.jobId, id));
              await recordAlong(
                observation,
                terminalResult(
                  data,
                  rows.map((row) => row.data),
                ),
                new Date(data.endedAt ?? Date.now()),
              );
            });
          } catch {
            console.error("[analytics] a shop result could not be read");
          }
        }
        return data.status === "completed" || data.status === "stopped";
      });
      if (terminal) owners.get(id)?.release();
    });
  return {
    owns: (id) => owners.has(id),
    async close() {
      await Promise.all(
        [...owners.values()].map(async (owner) => {
          await owner.pending;
          owner.release();
        }),
      );
    },
    async request(input) {
      return await db.transaction(async (tx) => requestShopJob(tx, input));
    },
    async claim() {
      return take("queued");
    },
    async record(id, product, total) {
      await owned(id, (client) =>
        drizzle(client).transaction(async (tx) => {
          const [row] = await tx.select().from(shopJobs).where(eq(shopJobs.id, id)).for("update");
          if (row?.status !== "running") return;
          const inserted = await tx
            .insert(shopJobProducts)
            .values({ jobId: id, productId: product.id, data: product })
            .onConflictDoNothing()
            .returning();
          if (!inserted.length)
            await tx
              .update(shopJobProducts)
              .set({ data: product })
              .where(and(eq(shopJobProducts.jobId, id), eq(shopJobProducts.productId, product.id)));
          const data = {
            ...row.data,
            read: row.data.read + inserted.length,
            total: total ?? row.data.total,
            revision: row.data.revision + 1,
          };
          await tx.update(shopJobs).set({ data }).where(eq(shopJobs.id, id));
        }),
      );
    },
    async total(id, total) {
      await update(id, () => ({ total }));
    },
    async currency(id, currency) {
      await update(id, () => ({ currency }));
    },
    async rate(id, rate) {
      await update(id, () => ({ rate: rateValue(rate) }));
    },
    async finish(id, result) {
      await update(id, () => ({ ...result, endedAt: new Date().toISOString() }));
    },
    async interrupted() {
      const rows = await db
        .select({ id: shopJobs.id })
        .from(shopJobs)
        .where(eq(shopJobs.status, "running"));
      for (const row of rows) {
        if (owners.has(row.id)) continue;
        const job = await take("running", row.id);
        if (!job) continue;
        try {
          await update(job.id, () => ({ ...interrupted, endedAt: new Date().toISOString() }));
        } finally {
          owners.get(job.id)?.release();
        }
      }
    },
    async snapshots(merchantId) {
      return db.transaction(
        async (tx) => {
          const jobs = await tx.select().from(shopJobs).where(eq(shopJobs.merchantId, merchantId));
          const rows = await tx
            .select({ jobId: shopJobProducts.jobId, data: shopJobProducts.data })
            .from(shopJobProducts)
            .innerJoin(shopJobs, eq(shopJobs.id, shopJobProducts.jobId))
            .where(eq(shopJobs.merchantId, merchantId))
            .orderBy(asc(shopJobProducts.productId));
          return jobs
            .map((one) => one.data)
            .sort((a, b) => b.sequence - a.sequence)
            .map((job) => ({
              job,
              rows: rows.filter((row) => row.jobId === job.id).map((row) => row.data),
            }));
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
    async latest(merchantId) {
      return (
        await db
          .select()
          .from(shopJobs)
          .where(eq(shopJobs.merchantId, merchantId))
          .orderBy(desc(shopJobs.id))
      )
        .map((one) => one.data)
        .sort((a, b) => b.sequence - a.sequence);
    },
    async rows(merchantId, id) {
      return (
        await db
          .select({ data: shopJobProducts.data })
          .from(shopJobProducts)
          .innerJoin(shopJobs, eq(shopJobs.id, shopJobProducts.jobId))
          .where(and(eq(shopJobs.merchantId, merchantId), eq(shopJobs.id, id)))
          .orderBy(asc(shopJobProducts.productId))
      ).map((one) => one.data);
    },
  };
}

/** A stored result is bound to the grant, currency and rate it actually checked. */
export async function jobIsCurrent(
  shops: WooShops,
  job: ShopJob,
  observedCurrency?: ShopCurrency,
): Promise<boolean> {
  const connection = await shops.connectionOf(job.accountId);
  const rate =
    job.rate === null
      ? null
      : await shops.currentRate(job.accountId, new URL(job.shopUrl).origin, job.rate.currency);
  return (
    connection?.revision === job.connectionRevision &&
    (!observedCurrency ||
      !job.currency ||
      (observedCurrency.code === job.currency.code &&
        observedCurrency.decimals === job.currency.decimals)) &&
    (job.currency === null ||
      (connection.currency?.code === job.currency.code &&
        connection.currency.decimals === job.currency.decimals)) &&
    (job.rate === null || rate?.version === job.rate.version)
  );
}
