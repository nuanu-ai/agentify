import { describe, expect, it } from "vitest";
import { scannerSamples } from "./telemetry.js";

const scan = {
  queued: "0",
  queue_age: 0,
  running: "0",
  stale_running: "0",
  accepted: "0",
  completed: "0",
  partial: "0",
  failed: "0",
  duration_count: "0",
  p50: null,
  p95: null,
};

describe("scanner operational observations", () => {
  it("shows an idle queue as empty and leaves unobserved completion latency absent", () => {
    const samples = scannerSamples(scan, []);
    expect(samples.find((s) => s.name === "agentify_scanner_queued")?.value).toBe(0);
    expect(samples.some((s) => s.name === "agentify_scanner_completion_duration_seconds")).toBe(
      false,
    );
  });
  it("includes stranded processing deliveries in analytics retry lag", () => {
    const samples = scannerSamples({ ...scan, queued: "3", queue_age: 42, stale_running: "1" }, [
      { status: "processing", count: "2", retry_lag: 123 },
      { status: "dead_letter", count: "1", retry_lag: 999 },
    ]);
    expect(samples.find((s) => s.name === "agentify_scanner_queued")?.value).toBe(3);
    expect(samples.find((s) => s.name === "agentify_scanner_stale_running")?.value).toBe(1);
    expect(samples.find((s) => s.name === "agentify_analytics_retry_lag_seconds")?.value).toBe(123);
    expect(
      samples.find(
        (s) => s.name === "agentify_analytics_outbox" && s.labels?.status === "processing",
      )?.value,
    ).toBe(2);
  });
  it("reports durable completion outcomes and their sample count without dividing unlike cohorts", () => {
    const samples = scannerSamples(
      {
        ...scan,
        accepted: "4",
        completed: "2",
        partial: "1",
        failed: "1",
        duration_count: "3",
        p50: 2,
        p95: 5,
      },
      [],
    );
    expect(
      samples.find(
        (s) => s.name === "agentify_scanner_completed_recent" && s.labels?.status === "partial",
      )?.value,
    ).toBe(1);
    expect(
      samples.find(
        (s) =>
          s.name === "agentify_scanner_completion_duration_seconds" &&
          s.labels?.quantile === "0.95",
      )?.value,
    ).toBe(5);
    expect(samples.find((s) => s.name === "agentify_scanner_completion_observations")?.value).toBe(
      3,
    );
  });
});
