import type { ReportResponse } from "@agentify/scanner-contracts";

/**
 * The segment average beside the score. It renders only once the sample
 * gate is met: at least thirty scans of the same segment that finished,
 * completed or partial, with coverage of 70% or more, which is what the
 * methodology page promises. Before that there is nothing here rather than a
 * number that does not exist. The cohort is the segment the scan was started
 * from, and the front page has been the owner segment since it existed.
 */
export function ReportBenchmark({
  benchmark,
}: Readonly<{ benchmark: ReportResponse["benchmark"] }>) {
  if (!benchmark) return null;
  return (
    <p>
      Segment average {Math.round(benchmark.average_score)} from{" "}
      {benchmark.sample_size} scans
    </p>
  );
}
