/**
 * A request's path as a proxy's log line carries it. An order's status address
 * is written as its route's template, because its one variable segment is the
 * buyer's key, which opens the order and its goods to whoever reads the line.
 * Every other path is written as it came, without its query string.
 */

import { API_ROUTES } from "@nuanu-ai/agentify-contracts";

const STATUS_ROUTE = API_ROUTES.get_order_status.path;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const STATUS_ADDRESS = new RegExp(
  `^${STATUS_ROUTE.split(/:[a-z][a-z0-9_]*/)
    .map(escaped)
    .join("[^/]+")}/?$`,
);

export const loggedPath = (url: string | undefined): string => {
  const path = (url ?? "").split("?", 1)[0] ?? "";
  return STATUS_ADDRESS.test(path) ? STATUS_ROUTE : path;
};
