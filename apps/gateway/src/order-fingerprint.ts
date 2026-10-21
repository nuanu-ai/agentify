/**
 * How a log line names an order: `order ` and the first twelve hex characters
 * of the identifier's SHA-256. The identifier itself opens the order and its
 * goods to whoever holds it, and logs travel further than the database, so no
 * line carries it. Twelve characters tell a million orders apart with rare
 * collisions, and an operator with the database finds the order from them with
 * the query in the telemetry runbook.
 */

import { createHash } from "node:crypto";

export const orderFingerprint = (orderId: string): string =>
  `order ${createHash("sha256").update(orderId, "utf8").digest("hex").slice(0, 12)}`;
