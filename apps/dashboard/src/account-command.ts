/**
 * What a signed-in person cannot do for themselves: list who can sign in, end
 * every session a person has, and set the operator flag. None of these creates
 * an account; an account is made when its person consumes a sign-in link.
 */

import { emailAs, type Identity } from "./identity.js";
import { printable } from "./printable.js";

/**
 * Not the real grammar of an address: it catches the mistakes made at a
 * terminal (a missing half, a space, a bare word), and nothing here sends
 * anything to the address.
 */
const LOOKS_LIKE_AN_ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const USAGE = [
  "Usage: pnpm --filter @agentify/dashboard account <command>",
  "",
  "  revoke <address>          end every session that person has, keeping the account",
  "  operator <address>        let that person read the operator's dashboard at",
  "                            /admin; they must have signed in once already",
  "  operator <address> --off  take that away again",
  "  list                      the accounts there are, their merchant, how many",
  "                            sessions are open, and who is an operator",
  "",
  "None of them makes an account: an account is made when its person opens the",
  "link the dashboard mails to their address, and a merchant when they press the",
  "dashboard's one control.",
];

/** Postgres's own answer for "there is no table by that name". */
const NO_SUCH_TABLE = "42P01";

/**
 * The store never lets the driver's exception out, since its message carries
 * every bound parameter; what arrives is a sentence with the database's code
 * beside it, and the code is what this reads.
 */
const missingTables = (thrown: unknown): boolean =>
  typeof thrown === "object" &&
  thrown !== null &&
  "code" in thrown &&
  String((thrown as { code: unknown }).code) === NO_SUCH_TABLE;

export interface Terminal {
  readonly say: (line: string) => void;
  /**
   * Handed in so a test can place itself at a moment when a session is alive,
   * rather than depending on the hour it runs at.
   */
  readonly now?: () => Date;
}

/**
 * Returns the exit code. Only a database the dashboard's migrations have never
 * run against is answered here rather than thrown, because the database's own
 * sentence for it does not say what to run; every other failure goes up as it
 * is.
 */
export async function runAccount(
  argv: readonly string[],
  identity: Identity,
  terminal: Terminal,
): Promise<number> {
  const print = terminal.say;
  const now = terminal.now ?? (() => new Date());
  // Every line goes through `printable`, because an address can carry
  // characters a terminal obeys instead of showing (an escape that clears the
  // line, a carriage return over the row above, a direction override), and a
  // listing where one row can hide another cannot answer who can sign in.
  const say = (line: string): void => print(printable(line));
  try {
    return await dispatch(argv, identity, say, now);
  } catch (thrown) {
    if (!missingTables(thrown)) {
      throw thrown;
    }
    say("The dashboard's tables are not in this database yet.");
    say("Run: pnpm --filter @agentify/dashboard db:migrate");
    return 1;
  }
}

async function dispatch(
  argv: readonly string[],
  identity: Identity,
  say: (line: string) => void,
  now: () => Date,
): Promise<number> {
  const [verb, address] = argv;

  if (verb === "list") {
    return await listAccounts(identity, say, now);
  }
  if (verb !== "revoke" && verb !== "operator") {
    for (const line of USAGE) {
      say(line);
    }
    return 2;
  }
  if (address === undefined) {
    say(`The ${verb} command needs an address: ${verb} someone@example.com`);
    return 2;
  }
  if (!LOOKS_LIKE_AN_ADDRESS.test(address.trim())) {
    say(`"${address}" is not an address of the shape someone@example.com.`);
    return 2;
  }

  if (verb === "operator") {
    return await flagOperator(identity, say, address, argv.slice(2));
  }
  return await revokeSessions(identity, say, address);
}

/**
 * Only an existing account can carry the flag, so an address nobody has signed
 * in as is refused rather than remembered: a privilege must not be granted
 * before the mailbox is proved. No session is ended either way, because the
 * flag is read with the session on every request.
 */
async function flagOperator(
  identity: Identity,
  say: (line: string) => void,
  address: string,
  rest: readonly string[],
): Promise<number> {
  const email = emailAs(address);
  const off = rest[0] === "--off";
  if (rest.length > 1 || (rest.length === 1 && !off)) {
    say("The operator command takes an address and, to take the flag away, --off:");
    say(`    operator ${email}`);
    say(`    operator ${email} --off`);
    return 2;
  }
  if (!(await identity.setOperator(email, !off))) {
    say(`Nobody has an account at ${email}, so there is nobody to flag.`);
    say("An account is made when its person signs in: they sign in once with that address,");
    say("and then this command can flag it.");
    return 1;
  }
  if (off) {
    say(
      `${email} is not an operator. From their next request, /admin is the site's 404 page for them.`,
    );
    return 0;
  }
  // Said as a condition: the person may not be signed in now.
  say(`${email} is an operator. /admin draws the operator's dashboard for them from their`);
  say("next request, whenever they are signed in.");
  return 0;
}

async function revokeSessions(
  identity: Identity,
  say: (line: string) => void,
  address: string,
): Promise<number> {
  // Asked first, because "nothing to end" and "nobody by that address" are
  // different answers and only one means a typo.
  if ((await identity.byEmail(address)) === null) {
    say(`Nobody has an account at ${address.trim()}, so there are no sessions to end.`);
    return 1;
  }

  const ended = await identity.endEverySessionFor(address);
  say(
    ended === 1
      ? `Ended 1 session for ${address.trim()}. The account is untouched.`
      : `Ended ${ended} sessions for ${address.trim()}. The account is untouched.`,
  );
  return 0;
}

async function listAccounts(
  identity: Identity,
  say: (line: string) => void,
  now: () => Date,
): Promise<number> {
  const listed = await identity.list(now());
  if (listed.length === 0) {
    say("There are no accounts. Nobody can sign into this dashboard yet.");
    say("An account is made when its person opens the link the dashboard mails to their address.");
    return 0;
  }

  // Rendered before it is measured, so the column is as wide as what a person
  // sees.
  const rows = listed.map((row) => ({ ...row, email: printable(row.email) }));
  const widest = Math.max(...rows.map((row) => row.email.length));
  for (const row of rows) {
    const open = row.sessions === 1 ? "1 session open" : `${row.sessions} sessions open`;
    // A person with no merchant is signed in but has not finished setup.
    const whose = row.merchant ?? "no merchant, setup pending";
    const address = row.confirmed ? "address confirmed" : "address not confirmed";
    const role = row.operator ? "operator" : "not an operator";
    say(
      `${row.email.padEnd(widest)}  made ${row.createdAt.toISOString().slice(0, 10)}  ${open}  ${address}  ${role}  ${whose}`,
    );
  }
  return 0;
}
