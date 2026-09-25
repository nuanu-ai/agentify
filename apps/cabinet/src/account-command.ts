/**
 * The operations that keep the accounts there are.
 *
 * None of them makes an account. An account comes into being one way: a person
 * types their address, opens the link the cabinet mails to it, and the cabinet
 * makes the account when the link is consumed (ADR-0026 §1); a merchant is made
 * when that person presses the cabinet's one control (ADR-0014). What is left
 * here is what a signed-in person cannot do for themselves: listing who can
 * sign in, ending every session a person has, and the flag that opens the
 * operator's dashboard (ADR-0026 §6).
 */

import { emailAs, type Identity } from "./identity.js";
import { printable } from "./printable.js";

/**
 * A shape an address has to have before anything is done with it.
 *
 * Deliberately not an attempt at the real grammar of an address, which is
 * larger than anybody thinks. What it catches is the mistakes somebody actually
 * makes at a terminal — a missing half, a space in the middle, a bare word —
 * and nothing here ever sends anything to the address anyway.
 */
const LOOKS_LIKE_AN_ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const USAGE = [
  "Usage: pnpm --filter @agentify/cabinet account <command>",
  "",
  "  revoke <address>          end every session that person has, keeping the account",
  "  operator <address>        let that person read the operator's dashboard at",
  "                            /admin; they must have signed in once already",
  "  operator <address> --off  take that away again",
  "  list                      the accounts there are, their merchant, how many",
  "                            sessions are open, and who is an operator",
  "",
  "None of them makes an account: an account is made when its person opens the",
  "link the cabinet mails to their address, and a merchant when they press the",
  "cabinet's one control.",
];

/** Postgres's own answer for "there is no table by that name". */
const NO_SUCH_TABLE = "42P01";

/**
 * Whether this is the database saying the cabinet's tables are not there.
 *
 * The store never lets the driver's own exception out — its message is the SQL
 * it tried followed by every bound parameter — so what arrives here is a
 * sentence and the database's own code carried beside it, and the code is what
 * this reads. It lives in this file rather than in the wiring next door because
 * this is where the sentences an operator reads are, and where they are tested.
 */
const missingTables = (thrown: unknown): boolean =>
  typeof thrown === "object" &&
  thrown !== null &&
  "code" in thrown &&
  String((thrown as { code: unknown }).code) === NO_SUCH_TABLE;

/** The terminal this command is run at, handed in rather than reached for. */
export interface Terminal {
  /** One line to whoever is watching. */
  readonly say: (line: string) => void;
  /**
   * The moment this run happens at, with the obvious default.
   *
   * So that a test asking what the listing says about a session can put itself
   * at a moment when that session is alive. Reading the wall clock here instead
   * made one test fail every day after nine in the evening, which is a test
   * that reports on the hour rather than on the code.
   */
  readonly now?: () => Date;
}

/**
 * Runs one command. The answer is the exit code.
 *
 * One failure is answered here rather than thrown: a database that has never
 * had the cabinet's migrations run against it. It is the first thing a person
 * meets on a new machine, and the database's own sentence for it names a table
 * they have never heard of and does not say what to run. Everything else goes
 * up as it is — an unfamiliar failure with a sentence invented over it is worse
 * than an unfamiliar failure.
 */
export async function runAccount(
  argv: readonly string[],
  identity: Identity,
  terminal: Terminal,
): Promise<number> {
  const print = terminal.say;
  const now = terminal.now ?? (() => new Date());
  // Everything this command prints goes through one rendering, rather than the
  // half-dozen places that print an address, because forgetting one of those is
  // the whole failure. What it takes out is the characters a terminal obeys
  // instead of showing: an escape that clears the line it is on, a carriage
  // return that writes over the row above, an override that reverses the
  // direction text reads in. An address carrying one arrives either from
  // somebody's shell or from a row written by hand, and a list of accounts
  // where one row can hide another cannot answer "who can sign into this
  // cabinet", which is the only question it is for.
  const say = (line: string): void => print(printable(line));
  try {
    return await dispatch(argv, identity, say, now);
  } catch (thrown) {
    if (!missingTables(thrown)) {
      throw thrown;
    }
    say("The cabinet's tables are not in this database yet.");
    say("Run: pnpm --filter @agentify/cabinet db:migrate");
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
 * Sets or clears the flag that opens the operator's dashboard (ADR-0026 §6).
 *
 * Only an account can carry it, and an account is written when its person
 * signs in, so an address nobody has signed in as is refused rather than
 * remembered: a privilege granted before the mailbox is proved, and kept apart
 * from the row it belongs to, is what the decision set out not to have.
 *
 * No session is ended either way. The flag is read with the session on every
 * request, so the person's next page already follows it.
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
  // Said as a condition, because the person may not be signed in now, and the
  // flag waits for a session to read it.
  say(`${email} is an operator. /admin draws the operator's dashboard for them from their`);
  say("next request, whenever they are signed in.");
  return 0;
}

async function revokeSessions(
  identity: Identity,
  say: (line: string) => void,
  address: string,
): Promise<number> {
  // Asked before it is done, because ending nothing and there being nobody are
  // two different answers and only one of them means somebody mistyped.
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
    say("There are no accounts. Nobody can sign into this cabinet yet.");
    say("An account is made when its person opens the link the cabinet mails to their address.");
    return 0;
  }

  // Rendered before it is measured, not after: the column is as wide as what a
  // person will see, and an address that grew when it was rendered would
  // otherwise push its own row out of line.
  const rows = listed.map((row) => ({ ...row, email: printable(row.email) }));
  const widest = Math.max(...rows.map((row) => row.email.length));
  for (const row of rows) {
    const open = row.sessions === 1 ? "1 session open" : `${row.sessions} sessions open`;
    // The merchant's identifier, which says which catalogue this person's
    // screens show. A person with none is authenticated P1 whose setup has not
    // attached a merchant yet.
    const whose = row.merchant ?? "no merchant, setup pending";
    // Whether the address has been confirmed by consuming a link.
    const address = row.confirmed ? "address confirmed" : "address not confirmed";
    // Whether this person may read the operator's dashboard.
    const role = row.operator ? "operator" : "not an operator";
    say(
      `${row.email.padEnd(widest)}  made ${row.createdAt.toISOString().slice(0, 10)}  ${open}  ${address}  ${role}  ${whose}`,
    );
  }
  return 0;
}
