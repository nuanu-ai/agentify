/**
 * `agentify verify` — the check a merchant runs on their cards before they
 * publish them.
 *
 * It checks one thing, in full: whether a card is enough for an agent to
 * assemble a correct purchase, read the way publication reads it. Whether the
 * merchant's handler holds against one order delivered twice is not something
 * a command holding only card files can try — no route raises an order for a
 * merchant's own card — so it is not one of this command's checks, and the
 * output says so and where it is proved instead: with a test purchase against
 * the merchant's own delivery system. Counted here as a check that "did not
 * run", it made every complete card answer as something short of success, and
 * a build reading the exit code took a good card for a failure.
 *
 * Which cards are checked is asked for rather than discovered. Nothing in this
 * package, in the contract or in any decision says where a merchant keeps
 * their cards, and a command that went looking would be inventing a
 * convention — a file name, a directory, a manifest — that nobody agreed to
 * and that every merchant would then have to work around.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Problem } from "@nuanu-ai/agentify-contracts";
import { checkCard } from "./check-card.js";
import { describeProblems } from "./schema.js";

/** What the command answers with. */
export const VERIFY_EXIT = Object.freeze({
  /** Every card it was given is complete as far as the contract can tell. */
  PASSED: 0,
  /** A card has findings. */
  PROBLEMS: 1,
  /** The command was called with something it cannot work from. */
  USAGE: 2,
});

/** What this command does not check, and where that is proved instead. */
const NOT_CHECKED_HERE = [
  "Repeats of one order: not checked by this command.",
  "  Whether a second delivery of the same order makes second goods is proved",
  "  against your own delivery system, with a test purchase: the buyer has to",
  "  keep what the first delivery carried.",
].join("\n");

/** The code a finding carries when the file held no card to check at all. */
export const NOT_JSON = "not_json";

interface CardFile {
  readonly path: string;
  /**
   * How the card is named in the report: the file, and beside it the
   * merchant's own key where the file carries one.
   *
   * Both, because they answer different questions. The file is what the
   * merchant edits; the key is what their database and every order call it,
   * and a report that gave only the file would leave them matching one to the
   * other by hand across a directory of cards.
   */
  readonly name: string;
  readonly problems: readonly Problem[];
}

const nameOf = (file: string, card: unknown): string => {
  const key =
    typeof card === "object" && card !== null && "merchant_item_id" in card
      ? (card as { merchant_item_id: unknown }).merchant_item_id
      : undefined;

  return typeof key === "string" && key !== "" ? `${file} (${key})` : file;
};

const USAGE = [
  "Usage: agentify verify <card.json> [more-cards.json ...]",
  "",
  "Checks each card against the published contract before it is published.",
  "",
  "Answers: 0 every card is complete as far as the contract can tell, 1 a card",
  "has findings, 2 called with something it cannot work from. Whether your",
  "handler holds against an order delivered twice is not checked here.",
].join("\n");

/**
 * Why the bare command the documentation shows does not run.
 *
 * `agentify verify` with nothing after it would check the cards the merchant
 * has already published. The binding reason it cannot is the plainest one:
 * this command takes no key and no address, builds no client and asks the
 * gateway nothing, so it has no way to see anything that was published.
 *
 * The call it would have needed does exist, and saying so is the honest half
 * of the answer: `list_merchant_cards` returns published cards whole, each of
 * them the card its author wrote rather than an agent's projection of it. What
 * that route promises is worth repeating exactly, because every part of it is
 * easy to overstate. Whose cards it returns is settled: the merchant whose key
 * the call was made with, and nobody else. A card reaches that list by being accepted at
 * `publish_card`, which parses the same `CardSchema` and applies the same
 * price rule this package does, so the cards on it passed this check on the
 * day they went out — which is not the same as passing it now. The schema can
 * move, and the price rule is applied only at publication: a stored card is
 * parsed again on its way back out against the schema alone, so a card
 * published before the price rule tightened is read back as it was, and one
 * that no longer fits a schema that moved fails that read. And a
 * command that builds no client can never learn which version of the contract
 * the gateway is speaking. Publishing is more than this check, too: it can
 * refuse a card for reasons the contract does not carry, which `checkCard`
 * says in its own words.
 *
 * Taking no key is a choice and not a hole, which is worth saying here because
 * the first line of the message reads like a limitation somebody would set out
 * to remove. A check that read published cards over that route would all but
 * always pass — they got onto it by passing this very check — and a green that
 * cannot fail teaches a merchant to stop reading it. What would earn a keyed mode is a
 * dry run of publishing, which can refuse for reasons no schema carries; there
 * is no such route (`docs/research/00-open-questions.md`).
 *
 * So this is a stop and not a scolding, and it is answered as a call the
 * command cannot work from. The way through it is to name the card files, which are
 * the copy the merchant can still change — the file is what the next publish
 * carries, whether the card is new or an edit to one already out.
 */
const NOTHING_TO_CHECK = [
  "agentify verify was given no card files, and it does not go looking for them:",
  "  - this command takes no key and no address and builds no client, so it",
  "    cannot ask us anything about what you have published",
  "  - the call that would answer such a question does exist, list_merchant_cards,",
  "    and it returns published cards whole — but a card reaches that list by",
  "    being accepted at publish, which runs this same check, so what comes back",
  "    is cards that passed this check on the day they went out",
  "  - neither this command nor the contract says where you keep the cards you",
  "    publish from, and looking for a file name or a directory would invent a",
  "    convention nobody agreed to",
  "Name the card files instead. The file is what your next publish carries,",
  "whether the card is new or an edit to one already out.",
].join("\n");

const checkFile = (path: string): CardFile => {
  const name = basename(path);

  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`${path} could not be read: ${String(cause)}`);
  }

  let card: unknown;

  try {
    card = JSON.parse(text);
  } catch (cause) {
    return {
      path,
      name,
      problems: [
        {
          path: [],
          code: NOT_JSON,
          message: `${name} is not JSON, so there is no card in it to check: ${String(cause)}`,
        },
      ],
    };
  }

  return { path, name: nameOf(name, card), problems: checkCard(card).problems };
};

export type Say = (line: string) => void;

export const runVerify = async (argv: readonly string[], say: Say): Promise<number> => {
  const [command, ...files] = argv;

  if (command !== "verify") {
    say(command === undefined ? USAGE : `agentify does not know "${command}".\n\n${USAGE}`);
    return VERIFY_EXIT.USAGE;
  }

  if (files.length === 0) {
    say(NOTHING_TO_CHECK);
    say("");
    say(USAGE);
    return VERIFY_EXIT.USAGE;
  }

  const checked: CardFile[] = [];

  for (const file of files) {
    try {
      checked.push(checkFile(file));
    } catch (cause) {
      say(String(cause instanceof Error ? cause.message : cause));
      return VERIFY_EXIT.USAGE;
    }
  }

  say("Card completeness");

  for (const card of checked) {
    if (card.problems.length === 0) {
      say(`  ${card.name}: complete as far as the contract can tell`);
      continue;
    }

    say(`  ${card.name}: ${card.problems.length} finding${card.problems.length === 1 ? "" : "s"}`);
    say(describeProblems(card.problems));
  }

  const faulted = checked.filter((card) => card.problems.length > 0);

  if (faulted.length > 0) {
    // The truncation, said out loud. A card is checked in two stages and the
    // second — the rules that compare one field against another — is only
    // reached when the first passes, so a short list is not a promise that
    // one round of fixes is enough.
    say(
      "  Fix these and run again: a card whose shape is wrong is not checked against the rules that compare one field with another, so there may be more behind them.",
    );
  }

  say("");
  say(NOT_CHECKED_HERE);
  say("");
  say(
    faulted.length > 0
      ? "Verdict: the cards have findings."
      : "Verdict: the cards are complete as far as the contract can tell.",
  );

  return faulted.length > 0 ? VERIFY_EXIT.PROBLEMS : VERIFY_EXIT.PASSED;
};
