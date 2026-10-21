/**
 * The address a request came from, as the edge in front of the dashboard wrote
 * it into `X-Forwarded-For`. The edge replaces whatever a browser sent there
 * with the one address its trusted-proxy boundary decided. The last entry is
 * read because a proxy that appends rather than replaces puts its own reading
 * last, while an earlier entry can be anything the browser sent. A request
 * that reached the dashboard without passing the edge, as on a laptop, counts
 * as one client.
 */
export const clientAddressOf = (forwardedFor: string | null): string =>
  forwardedFor?.split(",").at(-1)?.trim() || "unknown";
