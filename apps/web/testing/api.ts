/**
 * What the API routes' tests share: the settings of a scanner that reaches no
 * database and no dashboard, a request sent from the scanner's own pages, and
 * the error envelope every refusal carries. A route asked this way answers
 * whatever it decides before it needs either, and a database that cannot be
 * reached is one that listens nowhere.
 */

import { sessionCookieName } from "@agentify/scanner-contracts/report-identity";
import { vi } from "vitest";
import { ask } from "./scanner";

/** The scanner's own origin, which its routes take posts from. */
export const ORIGIN = "https://test.agentify.ad";

/** A database address where nothing listens, so every query fails at once. */
const NO_DATABASE = "postgresql://nobody:unused@127.0.0.1:1/nowhere";

/** Settings of a scanner with no database, no dashboard and no optional feature on. */
export function stubOfflineScanner(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_BASE_URL", ORIGIN);
  vi.stubEnv("DATABASE_URL", NO_DATABASE);
  vi.stubEnv("DASHBOARD_IDENTITY_URL", "");
  vi.stubEnv("REPORT_IDENTITY_SECRET", "");
  vi.stubEnv("REGISTRATION_ENABLED", "false");
  vi.stubEnv("CARD_SIGNAL_ENABLED", "false");
  vi.stubEnv("POSTHOG_BROWSER_KEY", "");
  vi.stubEnv("POSTHOG_BROWSER_HOST", "");
  // A refusal is logged as a warning, and a failure to reach the database as
  // an error; a test that reads the log spies on it again itself.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

/** A cookie header naming a session, which only the dashboard can say whose it is. */
export const SIGNED_IN = `${sessionCookieName(false)}=a-session`;

/** A request as the scanner's own pages send it, a JSON body and all. */
export const fromSite = (
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  ask(path, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

/** The error envelope every API refusal carries. */
export type Refusal = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  retry_after_seconds?: number;
}>;

export const refusalOf = async (answered: Response): Promise<Refusal> =>
  ((await answered.json()) as { error: Refusal }).error;

/** The methods a route says it takes. */
export const allowedAt = async (path: string): Promise<string | null> =>
  (await ask(path, { method: "OPTIONS" })).headers.get("allow");
