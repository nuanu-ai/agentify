import type { ReportResponse } from "@agentify/scanner-contracts";

/**
 * The segment average beside the score. The server sends it only once the
 * sample gate the methodology page promises is met: at least thirty finished
 * scans (completed or partial) of the same segment with coverage of 70% or
 * more. The cohort is the segment the scan was started from; the front page is
 * the owner segment.
 */
export function ReportBenchmark({
  benchmark,
}: Readonly<{ benchmark: ReportResponse["benchmark"] }>) {
  if (!benchmark) return null;
  return (
    <p>
      Segment average {Math.round(benchmark.average_score)} from {benchmark.sample_size} scans
    </p>
  );
}
