/**
 * The listing check (`listing-check.ts`) at the terminal: it takes the public
 * address of a running gateway, prints every probe with what came back whole,
 * and exits non-zero unless every probe was accepted.
 */

import {
  type ListingCheck,
  listingCheckOf,
  type Reach,
  type ValidateAnswer,
  type Verdict,
} from "./listing-check.js";

const USAGE = [
  "Usage: pnpm smoke:listing <base-url> [item-id ...]",
  "",
  "Asks the public CDP validation endpoint whether it would take this",
  "gateway's paid resources. With no item named it asks about every card in",
  "the public catalog.",
  "",
  "Each resource is also fetched from here, with the plain unpaid GET an agent",
  "reading it by hand sends, and held to what the door promises: a price, and a",
  "challenge naming the purchase as a POST.",
  "",
  "The gateway has to be reachable from the internet: the endpoint fetches",
  "the resource itself. A laptop is not reachable, and this command says so",
  "rather than reporting a pass it did not see.",
  "",
  "Nothing is spent. The endpoint is public, takes no key and moves no money.",
];

export async function runListingCheck(
  argv: readonly string[],
  reach: Reach,
  say: (line: string) => void,
): Promise<number> {
  const [baseUrl, ...named] = argv;

  if (baseUrl === undefined || baseUrl.trim() === "") {
    for (const line of USAGE) {
      say(line);
    }
    return 2;
  }

  const base = baseUrl.replace(/\/+$/, "");

  // A path is joined onto this, so a query or fragment lands in the middle of
  // every resource address, and the endpoint's refusal would read as though
  // the product were at fault.
  for (const [mark, what] of [
    ["?", "query"],
    ["#", "fragment"],
  ] as const) {
    if (base.includes(mark)) {
      say(`${baseUrl} carries a ${what}, and a path is joined onto this address.`);
      say("Give the address the gateway answers at and nothing after it.");
      return 2;
    }
  }

  if (!base.toLowerCase().startsWith("https://")) {
    // The endpoint answers 400 to an http address. This only warns: the
    // endpoint's rules are its own, and a run that asks and reports what came
    // back is worth more than one that decided in advance.
    say(`${base} is not an https address, and the endpoint only takes those.`);
    say("Expect no verdict. A listing needs a public https gateway.");
  }

  return printed(await listingCheckOf(base, named, reach), say);
}

function printed(checked: ListingCheck, say: (line: string) => void): number {
  if (checked.kind === "catalog_unreadable") {
    say(`The catalog at ${checked.base} could not be read: ${checked.why}`);
    say("Nothing was checked.");
    return 1;
  }
  if (checked.kind === "nothing_on_sale") {
    // The catalog is empty exactly when every card is paused or none was
    // published, which is when somebody most needs to be told.
    say(`There is nothing on sale at ${checked.base}, so there is nothing to check.`);
    return 1;
  }

  const unbuildable: string[] = [];
  for (const each of checked.resources) {
    say("");
    if ("unbuildable" in each) {
      say(`${JSON.stringify(each.itemId)}: no address could be built for it`);
      say(`  ${each.unbuildable}`);
      unbuildable.push(each.itemId);
      continue;
    }
    say(`GET ${each.resource}`);
    say(`  ${wordFor(each.door)}`);
    for (const probe of each.validator) {
      say("");
      say(`${probe.method} ${each.resource}`);
      say(`  ${wordFor(probe.verdict)}`);
      say(indented(probe.answer));
    }
  }

  say("");
  const { probes } = checked;
  // "It said no" and "no answer came" stay apart in the summary because only
  // the first is about the resource.
  if (checked.unanswered.length > 0) {
    say(
      `${checked.unanswered.length} of ${probes} probes got no verdict, so nothing is proven about them:`,
    );
    for (const silence of checked.unanswered) {
      say(`  ${silence}`);
    }
  }
  if (checked.refused.length > 0) {
    say(`${checked.refused.length} of ${probes} probes were refused:`);
    for (const failure of checked.refused) {
      say(`  ${failure}`);
    }
  }
  if (unbuildable.length > 0) {
    say(`${unbuildable.length} of ${checked.resources.length} products had no address to check:`);
    for (const itemId of unbuildable) {
      say(`  ${JSON.stringify(itemId)}`);
    }
  }
  if (checked.passed) {
    // Counts the products it was given rather than calling the whole catalog
    // good: a missing paging field is not a promise that there is nothing more.
    say(
      `All ${probes} probes over the ${checked.resources.length} products this catalog listed were accepted.`,
    );
    return 0;
  }
  return 1;
}

function wordFor(verdict: Verdict): string {
  switch (verdict.said) {
    case "valid":
      return "accepted";
    case "invalid":
      return verdict.why === undefined ? "refused" : `refused — ${verdict.why}`;
    case "no answer":
      return `no verdict — ${verdict.why}`;
  }
}

function indented(answer: ValidateAnswer): string {
  const text =
    answer.kind === "unreachable" ? answer.why : (JSON.stringify(answer.body, null, 2) ?? "null");
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
