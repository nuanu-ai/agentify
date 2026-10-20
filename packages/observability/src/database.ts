import { Pool } from "pg";

/** A separate, read-only connection keeps observability work off the application pool. */
export function telemetryDatabase(connectionString: string): Pool {
  const address = new URL(connectionString);
  address.searchParams.set(
    "options",
    "-c default_transaction_read_only=on -c statement_timeout=1500",
  );
  const pool = new Pool({
    connectionString: address.toString(),
    max: 1,
    connectionTimeoutMillis: 1_500,
    statement_timeout: 1_500,
    query_timeout: 2_000,
    options: "-c default_transaction_read_only=on",
    application_name: "agentify-telemetry",
  });
  // Query failures are reported by snapshot_success, without exception text
  // that could carry a connection string or a database document.
  pool.on("error", () => undefined);
  const notice = () => undefined;
  pool.on("acquire", (client) => client.on("error", notice));
  pool.on("release", (_error, client) => client.removeListener("error", notice));
  return pool;
}
