/**
 * `agentify verify`: the check a merchant runs on their card files before
 * publishing them, whether each card is enough for an agent to assemble a
 * correct purchase, read the way publication reads it.
 *
 * Whether the merchant's handler holds against one order delivered twice
 * cannot be tried by a command holding only card files, so the output says it
 * is not checked here and where it is proved instead; it does not count
 * against the exit code. The cards to check are named on the command line,
 * because nothing says where a merchant keeps them.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Problem } from "@nuanu-ai/agentify-contracts";
import { checkCard } from "./check-card.js";
import { describeProblems } from "./schema.js";

/** What the command answers with. */
const VERIFY_EXIT = Object.freeze({
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
const NOT_JSON = "not_json";

interface CardFile {
  readonly path: string;
  /**
   * How the card is named in the report: the file, and beside it the
   * merchant's own key where the file carries one, so the merchant need not
   * match one to the other by hand.
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
 * What the bare command, with no card files, answers. This command takes no
 * key and builds no client, so it cannot see published cards; and checking
 * them would all but always pass, since a card is published only after the
 * same check. A green that cannot fail teaches a merchant to stop reading it.
 * The card files are what the next publish carries, so they are what to name.
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
    // The truncation, said out loud: the rules between fields are reached
    // only once the shape passes, so one round of fixes may not be enough.
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
