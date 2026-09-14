import type { CheckResult, Segment } from "@b2a/contracts";

const PRIORITY: Record<Segment, number[]> = {
  store: [6, 15, 12, 13, 4, 7],
  local: [6, 12, 13, 4, 7],
  owner: [12, 6, 13, 4, 7],
};

const CLUSTER: Record<number, string> = {
  1: "robots",
  2: "robots-policy",
  3: "robots-policy",
  5: "structured-data",
  6: "structured-data",
  9: "callable-metadata",
  10: "callable-metadata",
  11: "callable-auth",
  12: "content-access",
  13: "content-access",
  15: "commerce-machine-data",
};

const priorityIndex = (segment: Segment, id: number): number => {
  const index = PRIORITY[segment].indexOf(id);
  return index === -1 ? 100 + id : index;
};

export const selectFindings = (
  segment: Segment,
  checks: readonly CheckResult[],
) => {
  const sorted = checks
    .filter((check) => check.status === "fail" || check.status === "partial")
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "fail" ? -1 : 1;
      const impact =
        priorityIndex(segment, left.id) - priorityIndex(segment, right.id);
      if (impact) return impact;
      const leftLoss = left.applicableWeight - left.earnedWeight;
      const rightLoss = right.applicableWeight - right.earnedWeight;
      return rightLoss - leftLoss || left.id - right.id;
    });
  const clusters = new Set<string>();
  const negatives: number[] = [];
  for (const check of sorted) {
    const cluster = CLUSTER[check.id] ?? `check-${check.id}`;
    if (clusters.has(cluster)) continue;
    clusters.add(cluster);
    negatives.push(check.id);
    if (negatives.length === 3) break;
  }
  const positive = checks
    .filter((check) => check.status === "pass" && check.earnedWeight > 0)
    .sort(
      (left, right) =>
        right.earnedWeight - left.earnedWeight || left.id - right.id,
    )[0];
  return {
    negativeCheckIds: negatives,
    ...(positive ? { positiveCheckId: positive.id } : {}),
  };
};
