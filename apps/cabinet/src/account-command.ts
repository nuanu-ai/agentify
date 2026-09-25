/**
 * The command that makes an account, and the operations that keep one.
 *
 * A merchant registers for themselves now (ADR-0014), so this is no longer the
 * only door into the cabinet. It is still the door somebody walks through when
 * a merchant already exists at the gateway and needs a person who can sign in
 * as them — which is what the first account on a deployed server is.
 *
 * The account starts unconfirmed. Reading a cabinet link is the only proof of
 * the mailbox, including for accounts seeded here.
 *
 * The merchant's key is not taken as an argument either, and for exactly the
 * same reason: it is a secret, the reasoning above does not care which kind,
 * and an argument is an argument. It is read from standard input instead, so
 * that whoever runs this can pipe it in from wherever they are holding it.
 *
 * What the key is checked against is the gateway, and that is the one thing
 * here that reaches the network. There are two kinds of key and they are the
 * same shape: one a merchant made for their own code, and one a cabinet signs
 * in with. Only the second belongs on a row — the first makes a cabinet that
 * works by halves, signing in but never replacing its key and offering a
 * control the gateway then refuses. Nothing on this side can tell them apart,
 * so this asks the party that can, with the call only the second kind is
 * allowed to make.
 */

import type { Answer } from "./gateway.js";
import { type AccountMerchant, emailAs, type Identity } from "./identity.js";
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

/**
 * The shortest key this will accept.
 *
 * The floor the gateway holds its own keys to. The comparison at the other end
 * is constant-time over equal lengths, and a key short enough to walk through
 * makes that care pointless. It is checked here because this is now the one
 * place a key is taken in at all — the cabinet has none in its configuration.
 */
const SHORTEST_KEY = 16;

const USAGE = [
  "Usage: pnpm --filter @agentify/cabinet account <command>",
  "",
  "  add <address> <merchant>  make an account for that merchant and print a",
  "                            sign-in address; the merchant's key is read",
  "                            from standard input",
  "  revoke <address>          end every session that person has, keeping the account",
  "  operator <address>        let that person read the operator's dashboard at",
  "                            /admin; they must have signed in once already",
  "  operator <address> --off  take that away again",
  "  list                      the accounts there are, their merchant, how many",
  "                            sessions are open, and who is an operator",
  "",
  "A merchant can register for themselves, and ask for a key once they are in",
  "(ADR-0014). This command is for the other case: a merchant that already",
  "exists at the gateway and needs somebody who can sign in as them.",
  "",
  "The merchant's key is read from standard input rather than taken as an",
  "argument, because an argument is in the shell's history and in the process",
  "list of everybody on the machine. Pipe it in from wherever you are holding",
  "it rather than typing it on the line that runs this.",
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

/**
 * Asking the gateway whether a key is one a cabinet can sign in with.
 *
 * There are two kinds of key and only one of them belongs on an account row.
 * The kind cannot be read off the value — they are the same shape — and the
 * gateway is the only party that knows, so this asks it the way anything asks
 * it: by making the call that only a cabinet's key is allowed to make, which is
 * the call every sign-in afterwards makes anyway. What comes back on a yes is
 * another key of that kind, which this command has no use for and throws away;
 * it is held by nobody and nothing comes back for it, which is one row of
 * litter per account made here.
 */
export type CabinetKeyCheck = (key: string) => Promise<Answer<string>>;

/** The terminal this command is run at, handed in rather than reached for. */
export interface Terminal {
  /** One line to whoever is watching. */
  readonly say: (line: string) => void;
  /**
   * The merchant's key, off standard input.
   *
   * A function rather than a value, so that it is read only by the one verb
   * that needs one. Read eagerly, the three verbs that have no key to take
   * would each sit waiting on a terminal with nothing printed.
   */
  readonly readKey: () => Promise<string>;
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
  askTheGateway: CabinetKeyCheck,
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
    return await dispatch(argv, identity, say, now, terminal.readKey, askTheGateway);
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
  readKey: () => Promise<string>,
  askTheGateway: CabinetKeyCheck,
): Promise<number> {
  const [verb, address, merchant] = argv;

  if (verb === "list") {
    return await listAccounts(identity, say, now);
  }
  if (verb !== "add" && verb !== "revoke" && verb !== "operator") {
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

  if (verb === "add") {
    return await addAccount(identity, say, address, merchant, readKey, askTheGateway);
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
  say(
    off
      ? `${email} is not an operator. /admin is a page that does not exist for them from their next request.`
      : `${email} is an operator. /admin opens for them on their next request, with the session they have.`,
  );
  return 0;
}

async function addAccount(
  identity: Identity,
  say: (line: string) => void,
  address: string,
  merchantId: string | undefined,
  readKey: () => Promise<string>,
  askTheGateway: CabinetKeyCheck,
): Promise<number> {
  // Both halves of the merchant before anything is generated or written. An
  // account made without them is one somebody can sign into and then see
  // nothing at all with, because the cabinet reaches the gateway with the key
  // on the row of whoever is signed in (ADR-0014 §2).
  if (merchantId === undefined || merchantId.trim() === "") {
    say(`The add command needs the merchant this account signs in for:`);
    say(`    add ${address.trim()} mer_the_identifier`);
    say("The merchant's key is read from standard input, not given here.");
    return 2;
  }
  // Nothing is guessed about the shape of an identifier the gateway hands out,
  // beyond it being one word: this value is a record of which catalogue the
  // account is looking at, and the gateway resolves the merchant from the key
  // rather than from this.
  if (/\s/.test(merchantId.trim())) {
    say(`"${merchantId}" is not a merchant identifier: it has a space in it.`);
    return 2;
  }

  const merchant = await merchantKey(say, merchantId.trim(), readKey, askTheGateway);
  if (merchant === null) {
    return 2;
  }

  const made = await identity.make(address, merchant);
  if (made === null) {
    // Not an overwrite. A repeated command must not move an existing person's
    // cabinet to a different merchant.
    say(`${address.trim()} already has an account. Nothing was changed.`);
    return 1;
  }

  say(`An unconfirmed account for ${made.email}, signing in as ${merchant.id}.`);
  say("They sign in by asking the cabinet to mail that address a one-time link.");
  return 0;
}

/**
 * The merchant's key off standard input, or null having said what was wrong.
 *
 * Trimmed, because a key arrives through a pipe and a pipe puts a newline on
 * the end of almost everything. A key with whitespace in the middle of it is
 * not a thing the gateway issues, so nothing is lost by it — and a key stored
 * with a stray newline is a cabinet whose every screen says the gateway will
 * not take this key, with nothing on the page to say why.
 *
 * Neither refusal quotes what arrived. It is a secret whether or not it is the
 * right one, and a terminal's scrollback is exactly where it should not be.
 */
async function merchantKey(
  say: (line: string) => void,
  id: string,
  readKey: () => Promise<string>,
  askTheGateway: CabinetKeyCheck,
): Promise<AccountMerchant | null> {
  const key = (await readKey()).trim();
  if (key === "") {
    say("The add command reads the merchant's key from standard input, and nothing arrived.");
    say("Pipe it in from wherever you are holding it rather than typing it on the line:");
    say("    ... | pnpm --filter @agentify/cabinet account add someone@example.com mer_x");
    return null;
  }
  if (key.length < SHORTEST_KEY) {
    say(
      `That key is shorter than ${SHORTEST_KEY} characters, which is not one the gateway issues.`,
    );
    return null;
  }

  // And now the one question this cannot answer for itself. Everything above is
  // about the shape of what arrived; whether it is a key a cabinet may sign in
  // with is a fact only the gateway holds, and a key of the wrong kind accepted
  // here is a cabinet that works by halves — signing in but never replacing its
  // key, and offering a control on the keys screen that the gateway refuses.
  // Asked last, so that nothing reaches the network for a value this command
  // can already see is wrong.
  const answered = await askTheGateway(key);
  if (answered.ok) {
    return { id, key };
  }
  if (answered.status === 403) {
    // The one refusal that is about the key rather than about the gateway, and
    // the only one somebody can do something about. It is said in full, because
    // "wrong kind of key" without the way to a right one is a person at a
    // terminal guessing.
    say("That is a key the merchant made for their own code, and an account signs in with the");
    say("other kind — the one a cabinet holds, which nobody types and no list of theirs shows.");
    say("Nothing turns one into the other. A key of that kind comes from registering, or from a");
    say("cabinet that is already signed in as this merchant; a merchant with neither cannot have");
    say("an account made for them here.");
    return null;
  }
  if (answered.status === 0) {
    // Not knowing is not the same as knowing it is fine. An account written on
    // a guess is the same broken cabinet, found later and by somebody else.
    say(`Nothing was written: the gateway did not answer, so there is no telling whether that`);
    say(`key is one a cabinet can sign in with. ${answered.why}.`);
    return null;
  }
  // Everything else is the gateway's own sentence under its own status: a key
  // it has never issued or has stopped accepting reads the same here, and
  // neither is ours to translate.
  say(`Nothing was written: the gateway would not accept that key. ${answered.why}.`);
  return null;
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
    say("A merchant can register for one from the cabinet, or make one here:");
    say("    ... | pnpm --filter @agentify/cabinet account add someone@example.com mer_x");
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
