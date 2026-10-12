import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import type { PgBoss } from "pg-boss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { A_NAME_PG_BOSS_ACCEPTS, ENVELOPES, PgBossQueue, REMINDERS, streamOf } from "./queue.js";

/**
 * Only the queue names can be checked without a database; the rest of this
 * adapter is pg-boss, checked under `pnpm test:db`. Here the names are held to
 * the rule beside them, and whether that rule is pg-boss's own is asked of
 * pg-boss in `queue.db-test.ts`.
 */
describe("the queue names", () => {
  it("use the Agentify namespace for durable work", () => {
    // Queue names persist in Postgres: renaming one makes a new queue and
    // leaves the old one's jobs with no reader.
    expect(ENVELOPES).toBe("agentify_envelopes");
    expect(REMINDERS).toBe("agentify_reminders");
    expect(streamOf("mch_a")).toBe("agentify_envelopes_mch_a");
  });

  it("give two merchants two different streams", () => {
    // A shared stream cannot be repaired by a filter: an envelope drawn by the
    // wrong merchant is not offered to its own until it is finished.
    expect(streamOf("mch_a")).not.toBe(streamOf("mch_b"));
    expect(streamOf("mch_a")).toMatch(A_NAME_PG_BOSS_ACCEPTS);
    expect(streamOf("mch_a").startsWith(ENVELOPES)).toBe(true);
  });

  it("refuse a merchant whose identifier could not name a queue", () => {
    // Left to pg-boss, this would surface only at the merchant's first sale,
    // looking like a worker that is not connected.
    expect(() => streamOf("a merchant")).toThrow(/cannot name a queue/);
    expect(() => streamOf("mch:a")).toThrow(/cannot name a queue/);
    expect(() => streamOf("")).toThrow(/cannot name a queue/);
  });
});

describe("what the queue reports of pg-boss's own failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs them without the values of the row a refused write quoted", () => {
    // pg-boss emits a worker's failure as an event whose detail can quote the
    // job's row.
    const said: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      said.push(...args);
    });
    const boss = new EventEmitter();
    PgBossQueue.over(boss as unknown as PgBoss, {
      pollIntervalMs: 50,
      reminders: { attempts: 3, retryDelayMs: 1_000 },
    });

    boss.emit("error", {
      message: "a worker failed",
      severity: "ERROR",
      code: "23514",
      detail: 'Failing row contains (job_1, {"orderId": "ord_buyer@example.com"}).',
    });

    expect(said.length).toBeGreaterThan(0);
    expect(inspect(said, { depth: Number.POSITIVE_INFINITY })).not.toContain("buyer@example.com");
  });
});
