import {
  browserObservationInputV1Schema,
  browserObservationOutputV1Schema,
  type BrowserObservationInputV1,
  type BrowserObservationOutputV1,
} from "@b2a/contracts";
import { ApifyClient } from "apify-client";

export type FinishedBrowserRun = {
  id: string;
  status:
    "SUCCEEDED" | "FAILED" | "ABORTED" | "TIMED-OUT" | "RUNNING" | "READY";
  usageUsd?: number;
};

export type RecentBrowserRun = Pick<FinishedBrowserRun, "id" | "status">;

export interface BrowserProviderClient {
  start(
    actorId: string,
    build: string,
    input: BrowserObservationInputV1,
    options: { timeoutSeconds: number; maxRunUsd: number },
  ): Promise<{ id: string }>;
  findRecentRun(
    actorId: string,
    operationId: string,
    startedAfter: Date,
  ): Promise<RecentBrowserRun | null>;
  waitForFinish(
    runId: string,
    waitSeconds: number,
  ): Promise<FinishedBrowserRun>;
  getUsage(runId: string): Promise<number | undefined>;
  getOutput(runId: string): Promise<BrowserObservationOutputV1>;
  abort(runId: string): Promise<void>;
  cleanup(runId: string): Promise<void>;
}

export class ApifyBrowserProviderClient implements BrowserProviderClient {
  readonly #client: ApifyClient;

  constructor(token: string) {
    this.#client = new ApifyClient({ token });
  }

  async start(
    actorId: string,
    build: string,
    input: BrowserObservationInputV1,
    options: { timeoutSeconds: number; maxRunUsd: number },
  ): Promise<{ id: string }> {
    const safeInput = browserObservationInputV1Schema.parse(input);
    const run = await this.#client.actor(actorId).start(safeInput, {
      build,
      timeout: options.timeoutSeconds,
      maxTotalChargeUsd: options.maxRunUsd,
      restartOnError: false,
    });
    return { id: run.id };
  }

  async findRecentRun(
    actorId: string,
    operationId: string,
    startedAfter: Date,
  ): Promise<RecentBrowserRun | null> {
    const page = await this.#client.actor(actorId).runs().list({
      desc: true,
      // Concurrency 1 can still produce hundreds of short runs in six hours.
      // Search the bounded provider maximum so a crash-window run is not missed.
      limit: 1_000,
      startedAfter,
    });
    for (const run of page.items) {
      const record = await this.#client
        .run(run.id)
        .keyValueStore()
        .getRecord("INPUT");
      const parsed = browserObservationInputV1Schema.safeParse(record?.value);
      if (parsed.success && parsed.data.operation_id === operationId)
        return { id: run.id, status: run.status } as RecentBrowserRun;
    }
    return null;
  }

  async waitForFinish(
    runId: string,
    waitSeconds: number,
  ): Promise<FinishedBrowserRun> {
    const run = await this.#client
      .run(runId)
      .waitForFinish({ waitSecs: waitSeconds });
    return {
      id: run.id,
      status: run.status,
      ...(run.usageTotalUsd === undefined
        ? {}
        : { usageUsd: run.usageTotalUsd }),
    } as FinishedBrowserRun;
  }

  async getUsage(runId: string): Promise<number | undefined> {
    const run = await this.#client.run(runId).get();
    const usage = run?.usageTotalUsd;
    return typeof usage === "number" && Number.isFinite(usage) && usage >= 0
      ? usage
      : undefined;
  }

  async getOutput(runId: string): Promise<BrowserObservationOutputV1> {
    const record = await this.#client
      .run(runId)
      .keyValueStore()
      .getRecord("OUTPUT");
    if (!record) throw new Error("apify_output_missing");
    return browserObservationOutputV1Schema.parse(record.value);
  }

  async abort(runId: string): Promise<void> {
    await this.#client.run(runId).abort({ gracefully: false });
  }

  async cleanup(runId: string): Promise<void> {
    const run = this.#client.run(runId);
    const results = await Promise.allSettled([
      run.keyValueStore().delete(),
      run.dataset().delete(),
      run.requestQueue().delete(),
    ]);
    if (results.some((result) => result.status === "rejected"))
      throw new Error("apify_storage_cleanup_failed");
  }
}
