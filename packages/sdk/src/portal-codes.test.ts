/**
 * The documentation's table of closing-call codes, held to the codes
 * themselves: a merchant writes their `switch` from it, so a code missing from
 * the page is an arm never written and a code nothing sends is an arm written
 * for nothing. The names are imported, not typed out, and only the names and
 * their count are checked, not the prose around them.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ORDER_CALL_ERROR_CODES } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { ANSWER_NOT_UNDERSTOOD, CALL_DID_NOT_REACH_US, OUTCOME_UNKNOWN } from "./client.js";

const page = fileURLToPath(new URL("../../../apps/docs/orders.md", import.meta.url));

/** The three this package produces where no answer it could read came back. */
const FROM_THE_TOOLS = [CALL_DID_NOT_REACH_US, ANSWER_NOT_UNDERSTOOD, OUTCOME_UNKNOWN];

/** The heading the table belongs to, so a table added elsewhere is not read as this one. */
const SECTION = "## When a call on an order does not go through";

/**
 * The first column of the first table under that heading. A row is a code
 * where its first cell is a single backticked word, which separates the codes
 * from the header without matching on its spelling.
 */
const codesOnThePage = (): string[] => {
  const markdown = readFileSync(page, "utf8");
  const section = markdown.indexOf(SECTION);

  if (section === -1) {
    throw new Error(`${SECTION} is not on the orders page, so the codes table cannot be found.`);
  }

  const codes: string[] = [];
  let started = false;

  for (const line of markdown.slice(section).split("\n")) {
    const named = /^\|\s*`([a-z_]+)`\s*\|/.exec(line);

    if (named?.[1] !== undefined) {
      started = true;
      codes.push(named[1]);
      continue;
    }

    // The table ends at the first line after it that is not one of its rows.
    if (started && !line.startsWith("|")) break;
  }

  return codes;
};

describe("the portal's table of codes a closing call fails under", () => {
  it("names every code those calls send, and no code they do not", () => {
    const promised = [...ORDER_CALL_ERROR_CODES, ...FROM_THE_TOOLS];
    const printed = codesOnThePage();

    expect([...printed].sort()).toStrictEqual([...promised].sort());
    // A code printed twice would still sort into a list with the right names.
    expect(printed).toHaveLength(promised.length);
  });
});
