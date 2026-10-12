/**
 * The database the database suite is allowed to empty: `agentify_test`, beside
 * the stack's `agentify` on the same server. The suite empties every table and
 * drops the queue's schema, so pointed at the stack's database it would wipe
 * what a running gateway and dashboard are serving.
 *
 * The database is created here, not only by the postgres service's init script:
 * Postgres runs `/docker-entrypoint-initdb.d` only on an empty data directory,
 * and the volume outlives `docker compose down`, so an existing volume never
 * gets it.
 */

import { Pool } from "pg";

export const TEST_DATABASE = "agentify_test";

const THE_STACK_DATABASE = "agentify";

export const DEFAULT_TEST_DATABASE_URL = `postgres://agentify:agentify@localhost:5432/${TEST_DATABASE}`;

/**
 * For a host whose Postgres is not on localhost:5432 (a deployment binds
 * 127.0.0.1:55432). It is separate from DATABASE_URL, which names the stack's
 * own database for `db:migrate`, and it wins when both are set.
 */
const TEST_DATABASE_URL_VARIABLE = "AGENTIFY_TEST_DATABASE_URL";

const NO_SUCH_DATABASE = "3D000";

/**
 * What the suite runs against: AGENTIFY_TEST_DATABASE_URL, else DATABASE_URL,
 * else the default. An address naming the stack's database is refused, and the
 * refusal names the variable that pointed there.
 */
export function testDatabaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string {
  const named = namedDatabaseUrl(environment);
  if (named === undefined) {
    return DEFAULT_TEST_DATABASE_URL;
  }

  const { variable, url } = named;
  const database = databaseNamedBy(variable, url);
  if (database === THE_STACK_DATABASE) {
    throw new Error(
      `${variable} names "${THE_STACK_DATABASE}", which is the database docker compose runs the` +
        ` gateway and the dashboard against. This suite empties every table it finds and drops the` +
        ` queue's schema, so it will not be pointed there. Leave ${TEST_DATABASE_URL_VARIABLE} and` +
        ` DATABASE_URL unset to use "${TEST_DATABASE}", or name any other database.`,
    );
  }
  if (database === "") {
    // An address with no database connects to the one named after the user,
    // which is `agentify` here, so it would slip past the refusal above.
    throw new Error(
      `${variable} stops at the server and names no database, and Postgres fills that in with the` +
        ` name of the user connecting — "${THE_STACK_DATABASE}" here, which is the database the` +
        ` dashboard is showing. Put the database on the end of the address:` +
        ` ".../${TEST_DATABASE}".`,
    );
  }
  return url;
}

/**
 * An empty DATABASE_URL means the default, as an unset one does. An empty
 * AGENTIFY_TEST_DATABASE_URL is refused: whoever set it is on a host where the
 * default's localhost:5432 is the wrong server, and falling back could empty
 * whatever answers there.
 */
function namedDatabaseUrl(
  environment: Record<string, string | undefined>,
): { variable: string; url: string } | undefined {
  const own = environment[TEST_DATABASE_URL_VARIABLE];
  if (own !== undefined) {
    if (own === "") {
      throw new Error(
        `${TEST_DATABASE_URL_VARIABLE} is set to nothing at all, which is not a way of asking for` +
          ` the default. Give it the address of the server this suite may empty, or unset it to` +
          ` use ${withoutPassword(DEFAULT_TEST_DATABASE_URL)}.`,
      );
    }
    return { variable: TEST_DATABASE_URL_VARIABLE, url: own };
  }

  const inherited = environment.DATABASE_URL;
  if (inherited === undefined || inherited === "") {
    return undefined;
  }
  return { variable: "DATABASE_URL", url: inherited };
}

/**
 * The refusal names the variable, never its value: a connection string carries
 * a password, and this message lands in CI output.
 */
function databaseNamedBy(variable: string, url: string): string {
  if (!URL.canParse(url)) {
    throw new Error(
      `${variable} is not an address. It has to be a Postgres connection string naming the` +
        ` database this suite may empty, of the shape` +
        ` "postgres://user:password@host:port/${TEST_DATABASE}".`,
    );
  }
  return databaseNameOf(url);
}

/**
 * Creates the database when the server lacks it. `null` means there is no
 * server at all, which the caller answers with one sentence rather than a wall
 * of connection errors.
 */
export async function readyDatabase(url: string): Promise<string | null> {
  const first = await tryConnecting(url);
  if (first === "ok") {
    return url;
  }
  if (first !== NO_SUCH_DATABASE) {
    return null;
  }

  const maintenance = new Pool({ connectionString: withDatabase(url, "postgres") });
  try {
    await maintenance.query(`create database "${databaseNameOf(url)}"`);
  } catch (error) {
    // Two runs starting at once both try to create it; the loser's "already
    // exists" is success.
    if (!isAlreadyThere(error)) {
      throw error;
    }
  } finally {
    await maintenance.end();
  }

  return (await tryConnecting(url)) === "ok" ? url : null;
}

export function noDatabaseHere(url: string): string {
  return (
    `\n  The database tests need a Postgres and there is none at ${withoutPassword(url)}.` +
    "\n  Start one with `docker compose up -d --wait postgres`, then:" +
    "\n    pnpm test:db\n"
  );
}

async function tryConnecting(url: string): Promise<"ok" | string> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("select 1");
    return "ok";
  } catch (error) {
    return codeOf(error) ?? "unreachable";
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function isAlreadyThere(error: unknown): boolean {
  return codeOf(error) === "42P04";
}

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

function withDatabase(url: string, name: string): string {
  const changed = new URL(url);
  changed.pathname = `/${name}`;
  return changed.toString();
}

function withoutPassword(url: string): string {
  const shown = new URL(url);
  if (shown.password !== "") {
    shown.password = "***";
  }
  return shown.toString();
}
