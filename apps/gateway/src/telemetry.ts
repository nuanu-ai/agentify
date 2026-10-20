import { deadlines, isOpen, ORDER_STATES, type Order } from "@agentify/core";
import {
  type MetricSample,
  type SnapshotMetric,
  SnapshotUnavailable,
  telemetry,
  telemetryDatabase,
} from "@agentify/observability/source";

const COMMERCE_SNAPSHOT_LIMIT = 1_000;
type OrderRow = { record: { order: Order } };

const metric = (suffix: string, help: string, labelNames?: string[]): SnapshotMetric => ({
  name: `agentify_commerce_${suffix}`,
  help,
  ...(labelNames ? { labelNames } : {}),
});
const commerceMetricDefinitions: SnapshotMetric[] = [
  metric("open_orders", "Retained orders still owing work or money"),
  metric("oldest_open_age_seconds", "Age since creation of the oldest open order"),
  metric(
    "payment_unknown_orders",
    "Retained orders with an unknown payment outcome, including closed orders",
  ),
  metric(
    "oldest_unknown_settlement_age_seconds",
    "Age since settlement started for the oldest unknown payment",
  ),
  metric("overdue_orders", "Orders whose currently armed core deadline is overdue"),
  metric("oldest_overdue_age_seconds", "Age since the oldest currently armed deadline fell due"),
  metric("overdue_by_deadline", "Overdue orders by their currently armed deadline", ["deadline"]),
  metric(
    "recent_orders",
    "Current states of unique retained orders created in the last 15 minutes",
    ["state"],
  ),
];

export function commerceSamples(rows: OrderRow[], now: number): MetricSample[] {
  if (rows.length > COMMERCE_SNAPSHOT_LIMIT) throw new SnapshotUnavailable("row_limit");
  let open = 0;
  let oldestOpen = 0;
  let unknown = 0;
  let oldestUnknown = 0;
  let overdue = 0;
  let oldestOverdue = 0;
  const byDeadline = new Map<string, number>();
  const recent = new Map<string, number>(ORDER_STATES.map((state) => [state, 0]));
  for (const {
    record: { order },
  } of rows) {
    if (!recent.has(order.state)) throw new SnapshotUnavailable("invalid_data");
    if (isOpen(order.state)) {
      open += 1;
      oldestOpen = Math.max(oldestOpen, now - order.timestamps.createdAt);
    }
    if (order.payment === "outcome_unknown") {
      unknown += 1;
      const started = order.timestamps.settleStartedAt;
      if (started === null || !Number.isFinite(started))
        throw new SnapshotUnavailable("invalid_data");
      oldestUnknown = Math.max(oldestUnknown, now - started);
    }
    if (order.timestamps.createdAt >= now - 15 * 60_000) {
      recent.set(order.state, (recent.get(order.state) ?? 0) + 1);
    }
    const late = deadlines(order).filter((deadline) => deadline.at < now);
    if (late.length > 0) overdue += 1;
    for (const deadline of late) {
      oldestOverdue = Math.max(oldestOverdue, now - deadline.at);
      byDeadline.set(deadline.kind, (byDeadline.get(deadline.kind) ?? 0) + 1);
    }
  }
  const point = (suffix: string, value: number): MetricSample => ({
    name: `agentify_commerce_${suffix}`,
    value,
  });
  return [
    point("open_orders", open),
    point("oldest_open_age_seconds", oldestOpen / 1_000),
    point("payment_unknown_orders", unknown),
    point("oldest_unknown_settlement_age_seconds", oldestUnknown / 1_000),
    point("overdue_orders", overdue),
    point("oldest_overdue_age_seconds", oldestOverdue / 1_000),
    ...[...byDeadline].map(([deadline, value]) => ({
      ...point("overdue_by_deadline", value),
      labels: { deadline },
    })),
    ...[...recent].map(([state, value]) => ({
      ...point("recent_orders", value),
      labels: { state },
    })),
  ];
}

export const COMMERCE_SNAPSHOT_QUERY = `
  select record from orders
  where open or record->'order'->>'payment' = 'outcome_unknown' or created_at >= $1
  limit $2`;

export function startCommerceTelemetry(databaseUrl: string): () => Promise<void> {
  const pool = telemetryDatabase(databaseUrl);
  const stop = telemetry.snapshot("commerce", commerceMetricDefinitions, async () => {
    const now = Date.now();
    const { rows } = await pool.query<OrderRow>(COMMERCE_SNAPSHOT_QUERY, [
      new Date(now - 15 * 60_000),
      COMMERCE_SNAPSHOT_LIMIT + 1,
    ]);
    return commerceSamples(rows, now);
  });
  return async () => {
    stop();
    await pool.end();
  };
}
