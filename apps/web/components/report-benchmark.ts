import type { ReportResponse } from "@agentify/scanner-contracts";

/**
 * The segment average, said in the caption under the score. The server sends
 * it only once the sample gate the methodology page promises is met: at least
 * thirty finished scans (completed or partial) of the same segment with
 * coverage of 70% or more. The cohort is the segment the scan was started
 * from; the front page is the owner segment.
 */
export function benchmarkCaption(benchmark: ReportResponse["benchmark"]): string | null {
  if (!benchmark) return null;
  return `Segment average ${Math.round(benchmark.average_score)} from ${benchmark.sample_size} scans`;
}
